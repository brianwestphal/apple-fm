/**
 * The line-delimited JSON (NDJSON) wire protocol between the Node layer and the
 * Swift helper, plus small pure helpers used by both the one-shot and chat
 * paths. Everything here is pure and unit-tested directly — no I/O.
 */
import type { GenerateRequest, HelperEvent, Message, ModelAvailability, ProbeResult, UnavailableReason } from './types.js';

export const MAX_HELPER_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_HELPER_STDERR_CHARS = 4096;

/** Bound a wire frame before retaining or parsing it. */
export function assertHelperFrameSize(frame: string): void {
  if (Buffer.byteLength(frame) > MAX_HELPER_FRAME_BYTES) {
    throw new Error('[protocolError] helper frame exceeds 4 MiB');
  }
}

/** One-line, bounded diagnostics from subprocess output. */
export function helperDiagnostic(value: string): string {
  return value.slice(0, MAX_HELPER_STDERR_CHARS)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();
}

/** Format a structured error from a helper without replaying a raw wire line. */
export function helperError(code: string, message: string): Error {
  const label = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(code) ? code : 'protocolError';
  return new Error(`[${label}] ${helperDiagnostic(message)}`);
}

function parseWireJson(line: string, label: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error(`malformed ${label} JSON`);
  }
}

/** Encode a generation request as the single JSON line the helper reads. */
export function encodeRequest(request: GenerateRequest): string {
  return JSON.stringify(request) + '\n';
}

/**
 * Split a streaming buffer into complete NDJSON lines plus the trailing
 * remainder that has not yet been terminated by a newline. Carry `rest` into the
 * next chunk.
 */
export function splitLines(buffer: string, bounded = false): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  if (bounded) for (const part of parts) assertHelperFrameSize(part);
  // The last element is whatever followed the final newline (often '').
  const rest = parts.pop() ?? '';
  const lines = parts.filter((line) => line.trim().length > 0);
  return { lines, rest };
}

/**
 * Parse one NDJSON line into a {@link HelperEvent}. Throws if the line is not a
 * recognized event shape, so callers can surface a clear protocol error rather
 * than silently dropping output.
 */
export function parseEvent(line: string): HelperEvent {
  const value = parseWireJson(line, 'helper event');
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error('malformed helper event');
  }
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'delta':
      if (typeof event.text !== 'string') break;
      return { type: 'delta', text: event.text };
    case 'snapshot':
      if (typeof event.content !== 'string') break;
      return { type: 'snapshot', content: event.content };
    case 'result':
      if (typeof event.content !== 'string') break;
      return { type: 'result', content: event.content };
    case 'error':
      if (typeof event.code !== 'string' || typeof event.message !== 'string') break;
      return { type: 'error', code: event.code, message: event.message };
    default:
      break;
  }
  throw new Error('malformed helper event');
}

/** The known reasons the model can be unavailable (see {@link UnavailableReason}). */
const UNAVAILABLE_REASONS: readonly string[] = [
  'deviceNotEligible',
  'appleIntelligenceNotEnabled',
  'modelNotReady',
  'unsupportedPlatform',
  'unknown',
];

/**
 * Parse the single bare JSON line emitted by `--probe` into a validated
 * {@link ProbeResult}. Unlike {@link parseEvent} this is not an NDJSON event — the line
 * *is* the result — but it is validated the same way so a malformed/hostile probe line
 * (non-boolean `available`, a missing or unknown `reason`) surfaces a clear protocol
 * error instead of being cast blindly and handed to callers (AFM-79). A throw here is
 * turned into a clean rejection by `helper.ts`'s `runHelper` delivery path.
 */
export function parseProbeResult(line: string): ProbeResult {
  const value = parseWireJson(line, 'probe result');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('malformed probe result');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.available !== 'boolean') {
    throw new Error('malformed probe result (available must be a boolean)');
  }
  const models = record.models === undefined ? {} : { models: parseModels(record.models) };
  const contextSize = parseContextSize(record.contextSize);
  const context = contextSize === undefined ? {} : { contextSize };
  if (record.available) return { available: true, ...models, ...context };
  if (typeof record.reason !== 'string' || !UNAVAILABLE_REASONS.includes(record.reason)) {
    throw new Error('malformed probe result (missing/unknown reason)');
  }
  return { available: false, reason: record.reason as UnavailableReason, ...models, ...context };
}

/** A zero capacity is a legacy marker for unavailable native accounting. */
export function parseContextSize(value: unknown): number | undefined {
  return value === undefined || value === 0 ? undefined : parseTokenCount(value);
}

/** Validate a numeric token count from the wire. */
export function parseTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('malformed helper token count');
  }
  return value;
}

/** Decode the numeric content returned by a token-count command. */
export function parseTokenCountResult(content: string): number {
  return parseTokenCount(parseWireJson(content, 'helper token count'));
}

function parseModels(value: unknown): ModelAvailability[] {
  if (!Array.isArray(value)) throw new Error('malformed probe result (models must be an array)');
  return value.map((entry: unknown) => {
    if (typeof entry === 'object' && entry !== null && 'id' in entry && typeof entry.id === 'string' &&
        'available' in entry) {
      if (entry.available === true) return { id: entry.id, available: true };
      if (entry.available === false && 'reason' in entry && typeof entry.reason === 'string') {
        return { id: entry.id, available: false, reason: entry.reason };
      }
    }
    throw new Error('malformed probe result (invalid model availability)');
  });
}

/**
 * Flatten a conversation into a single prompt with labeled turns. The helper is
 * stateless per one-shot call, so multi-turn context is replayed this way; the
 * system prompt is delivered separately as the session's instructions.
 *
 * This is the canonical labeled-turn format (`User:`/`Assistant:`, blank-line
 * separated). `session.ts:compact` reuses it, and `apple-fm-helper/main.swift`
 * (`userPrompt`) must mirror it byte-for-byte so on-device replay matches; the
 * format is pinned by a test in `tests/protocol.test.ts`.
 */
export function flattenMessages(messages: Message[]): string {
  return messages
    .map((message) => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${message.content}`)
    .join('\n\n');
}

/** Rough chars-per-token ratio for {@link estimateTokens}. */
const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate (~4 characters per token). Used only to decide when a
 * chat transcript should be compacted; it does not need to be exact, just
 * monotonic and cheap.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Sum the estimated tokens of a system prompt plus a conversation. */
export function estimateConversationTokens(system: string, messages: Message[]): number {
  const body = messages.reduce((total, message) => total + estimateTokens(message.content), 0);
  return estimateTokens(system) + body;
}
