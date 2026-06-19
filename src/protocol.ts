/**
 * The line-delimited JSON (NDJSON) wire protocol between the Node layer and the
 * Swift helper, plus small pure helpers used by both the one-shot and chat
 * paths. Everything here is pure and unit-tested directly — no I/O.
 */
import type { GenerateRequest, HelperEvent, Message } from './types.js';

/** Encode a generation request as the single JSON line the helper reads. */
export function encodeRequest(request: GenerateRequest): string {
  return JSON.stringify(request) + '\n';
}

/**
 * Split a streaming buffer into complete NDJSON lines plus the trailing
 * remainder that has not yet been terminated by a newline. Carry `rest` into the
 * next chunk.
 */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
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
  const value: unknown = JSON.parse(line);
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new Error(`malformed helper event: ${line}`);
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
  throw new Error(`malformed helper event: ${line}`);
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
