/**
 * Thin process layer over the Swift helper binary. Locates the helper, runs
 * `--probe` and `--generate`, and turns the NDJSON it emits into resolved values
 * or thrown errors. The pure protocol logic lives in `protocol.ts`; this file is
 * exercised in tests against a small `node -e` stub pointed at via `binPath`.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { encodeRequest, parseEvent, parseProbeResult, parseTokenCount, splitLines } from './protocol.js';
import type { DeltaHandler, GenerateRequest, HelperOptions, ProbeResult, SnapshotHandler } from './types.js';

/** Environment variable that pins the helper binary path. */
export const HELPER_BIN_ENV = 'APPLE_FM_BIN';

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Whether this platform can run the bundled on-device helper at all: macOS on
 * Apple Silicon. (Whether the *model* is usable then — macOS 26+, Apple
 * Intelligence enabled — is what {@link probe} checks.) apple-fm installs on any
 * OS so it can be a dependency of cross-platform projects; off-platform it
 * degrades gracefully rather than crashing — `probe` reports `unsupportedPlatform`
 * and `generate` / `ChatSession` throw a clear `[unsupportedPlatform]` error.
 */
export function isPlatformSupported(): boolean {
  return process.platform === 'darwin' && process.arch === 'arm64';
}

/**
 * True when no override is set, so a call would spawn the *bundled* macOS helper
 * — the only case the platform gate applies to. An explicit `binPath` /
 * `APPLE_FM_BIN` (e.g. the test stub, or a cross-built helper) is trusted as-is.
 */
export function usingBundledHelper(options: HelperOptions = {}): boolean {
  if (options.binPath !== undefined && options.binPath.length > 0) return false;
  const fromEnv = process.env[HELPER_BIN_ENV];
  return fromEnv === undefined || fromEnv.length === 0;
}

/** Error thrown when the bundled helper can't run on the current platform. */
export function unsupportedPlatformError(): Error {
  return new Error(
    `[unsupportedPlatform] apple-fm requires macOS 26+ on Apple Silicon; the ` +
      `on-device model cannot run on ${process.platform}/${process.arch}`,
  );
}

/**
 * Resolve the helper binary path: an explicit `binPath`, then the `APPLE_FM_BIN`
 * override (trusted as-is — an advanced/testing escape hatch), then the prebuilt
 * binary bundled with the package (`bin/apple-fm-helper`), addressed by an absolute
 * path relative to this module. There is **no bare-name `PATH` lookup** — the helper
 * is never resolved off `PATH`, so it can't be shadowed by a planted binary (AFM-66).
 */
export function resolveHelperPath(options: HelperOptions = {}): string {
  if (options.binPath !== undefined && options.binPath.length > 0) return options.binPath;
  const fromEnv = process.env[HELPER_BIN_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // dist/helper.js → ../bin/apple-fm-helper (package root).
  return fileURLToPath(new URL('../bin/apple-fm-helper', import.meta.url));
}

/**
 * Run the helper with the given args, feeding `input` (if any) on stdin and
 * calling `onLine` for each complete NDJSON line of stdout. Resolves on a clean
 * exit, rejects (with captured stderr) otherwise.
 */
function runHelper(
  args: string[],
  options: HelperOptions,
  input: string | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  const command = resolveHelperPath(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`apple-fm helper timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.on('error', (error) => {
      finish(new Error(`failed to run apple-fm helper (${command}): ${error.message}`));
    });

    // Run `onLine` defensively: a callback throw (malformed event, surfaced
    // error event) must reject the promise, not escape as an uncaught exception.
    const deliver = (line: string): boolean => {
      try {
        onLine(line);
        return true;
      } catch (error) {
        child.kill('SIGKILL');
        finish(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const { lines, rest } = splitLines(stdout);
      stdout = rest;
      for (const line of lines) if (!deliver(line)) return;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));

    child.on('close', (code) => {
      if (settled) return;
      // Flush any final line that arrived without a trailing newline.
      const trailing = stdout.trim();
      if (trailing.length > 0 && !deliver(trailing)) return;
      if (code === 0) finish();
      else finish(new Error(`apple-fm helper exited with code ${String(code)}: ${stderr.trim()}`));
    });

    if (input !== undefined) {
      child.stdin.on('error', () => undefined); // swallow EPIPE if the helper exits early
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

/** Ask the helper which models it exposes and whether each is available. */
export async function probe(options: HelperOptions = {}): Promise<ProbeResult> {
  // Off-platform (e.g. Linux/Windows, or an Intel Mac) the bundled macOS helper
  // can't run — report unavailable instead of failing to spawn it.
  if (usingBundledHelper(options) && !isPlatformSupported()) {
    return { available: false, reason: 'unsupportedPlatform' };
  }
  let result: ProbeResult | undefined;
  // `--probe` emits a single bare JSON line that *is* the ProbeResult (not an
  // NDJSON event); the last such line wins. Validate its shape (AFM-79) rather than
  // casting a possibly-malformed line straight to ProbeResult.
  await runHelper(['--probe'], options, undefined, (line) => {
    result = parseProbeResult(line);
  });
  if (result === undefined) throw new Error('apple-fm helper --probe produced no result');
  if (result.models !== undefined) result.models = result.models.filter((entry) => entry.id === 'on-device');
  return result;
}

/** Validate a model supplied by a caller, including untyped JavaScript callers. */
export function assertSupportedModel(model: string | undefined): void {
  if (model !== undefined && model !== 'on-device') {
    throw new Error(`unknown model "${model}" (run apple-fm probe)`);
  }
}

/** Count the native prompt tokens for this text. Requires macOS 26.4 or later. */
export async function countTokens(prompt: string, options: HelperOptions = {}): Promise<number> {
  if (usingBundledHelper(options) && !isPlatformSupported()) throw unsupportedPlatformError();
  let count: number | undefined;
  await runHelper(['--tokens'], options, encodeRequest({ prompt }), (line) => {
    const event = parseEvent(line);
    if (event.type === 'error') throw new Error(`[${event.code}] ${event.message}`);
    if (event.type === 'result') count = parseTokenCount(JSON.parse(event.content));
  });
  if (count === undefined) throw new Error('apple-fm helper --tokens produced no result');
  return count;
}

/**
 * Run one generation. When `request.stream` is set, freeform text is forwarded to
 * `onDelta` (append the suffix) and guided/structured output to `onSnapshot` (the
 * full partial JSON each time — replace, since structured partials are not
 * append-only). The resolved value is always the full text (or, for guided
 * generation, the complete JSON string).
 */
export async function generate(
  request: GenerateRequest,
  options: HelperOptions = {},
  onDelta?: DeltaHandler,
  onSnapshot?: SnapshotHandler,
): Promise<string> {
  if (usingBundledHelper(options) && !isPlatformSupported()) throw unsupportedPlatformError();
  let content: string | undefined;
  const { model, useCase, ...wireRequest } = request;
  assertSupportedModel(model);
  const tagging = useCase === 'content-tagging';
  if (useCase !== undefined && useCase !== 'general' && !tagging) {
    throw new Error('unknown use case (choose general or content-tagging)');
  }
  if (tagging && (request.stream === true || request.schema !== undefined)) {
    throw new Error('content-tagging cannot be combined with streaming or a custom schema');
  }
  const mode = tagging ? '--tag-content' : '--generate';
  await runHelper([mode], options, encodeRequest(wireRequest), (line) => {
    const event = parseEvent(line);
    switch (event.type) {
      case 'delta':
        onDelta?.(event.text);
        break;
      case 'snapshot':
        onSnapshot?.(event.content);
        break;
      case 'result':
        content = event.content;
        break;
      case 'error':
        throw new Error(`[${event.code}] ${event.message}`);
    }
  });
  if (content === undefined) throw new Error(`apple-fm helper ${mode} produced no result`);
  return content;
}
