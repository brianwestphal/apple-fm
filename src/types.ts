/**
 * Shared types for apple-fm.
 *
 * The Node layer never imports `FoundationModels` directly — it spawns the Swift
 * helper (`apple-fm-helper`) and exchanges line-delimited JSON. These types
 * describe that wire contract and the public API built on top of it.
 */

/** A conversational role. The on-device model is instructed via `system`. */
export type Role = 'user' | 'assistant';

/** One turn in a conversation. */
export interface Message {
  role: Role;
  content: string;
}

/** Per-request generation knobs, passed through to the on-device session. */
export interface GenerateOptions {
  /** Sampling temperature (0–2). Omitted ⇒ the model's default. */
  temperature?: number;
  /** Cap on the response length, in tokens. Omitted ⇒ the model's default. */
  maxTokens?: number;
}

/**
 * A single generation request sent to the helper's `--generate` mode.
 *
 * Provide either `prompt` (a single user turn) or `messages` (a full
 * conversation, replayed as the session transcript). `schema`, when present,
 * requests guided generation that conforms to the given JSON Schema.
 */
export interface GenerateRequest {
  /** Instructions for the session (the system prompt). */
  system?: string;
  /** A single user turn. Mutually exclusive with `messages`. */
  prompt?: string;
  /** A full conversation. Mutually exclusive with `prompt`. */
  messages?: Message[];
  /** JSON Schema for guided/structured output. */
  schema?: unknown;
  /** Generation knobs. */
  options?: GenerateOptions;
  /** Stream partial output as `delta` events (default: false). */
  stream?: boolean;
}

/**
 * Why the on-device model is or isn't usable right now. The first three +
 * `unknown` come from the Swift helper; `unsupportedPlatform` is reported by the
 * Node layer *without* running the helper, when the OS/CPU can't run it at all
 * (not macOS on Apple Silicon).
 */
export type UnavailableReason =
  | 'deviceNotEligible'
  | 'appleIntelligenceNotEnabled'
  | 'modelNotReady'
  | 'unsupportedPlatform'
  | 'unknown';

/** Result of `apple-fm-helper --probe`. */
export interface ProbeResult {
  available: boolean;
  /** Present only when `available` is false. */
  reason?: UnavailableReason;
}

/**
 * One line of helper output (NDJSON). When streaming, freeform text emits `delta`
 * events (append the suffix) while guided/structured output emits `snapshot`
 * events (the full partial value — replace, since structured partials are not
 * append-only). Every successful generation ends with exactly one `result`.
 * Failures emit a single `error`.
 */
export type HelperEvent =
  | { type: 'delta'; text: string }
  | { type: 'snapshot'; content: string }
  | { type: 'result'; content: string }
  | { type: 'error'; code: string; message: string };

/** Options for locating + invoking the helper binary. */
export interface HelperOptions {
  /** Explicit path to the helper binary. Overrides discovery. */
  binPath?: string;
  /** Milliseconds before a one-shot generation is aborted (default 120_000). */
  timeoutMs?: number;
}

/** Callback fired for each streamed text chunk (append the suffix). */
export type DeltaHandler = (text: string) => void;

/**
 * Callback fired for each full partial value during guided/structured streaming.
 * Each call carries the complete current JSON (replace, not append) — structured
 * partials are not append-only.
 */
export type SnapshotHandler = (content: string) => void;
