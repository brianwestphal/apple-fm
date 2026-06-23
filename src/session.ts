/**
 * A multi-turn chat session over the on-device model, with automatic context
 * compaction.
 *
 * The on-device model has a small context window, so a long conversation will
 * eventually overflow it. {@link ChatSession} holds the transcript on the Node
 * side and, when the estimated size crosses a threshold, summarizes the older
 * turns into a compact recap (using the same on-device model) and continues with
 * that recap plus the most recent turns kept verbatim. The conversation stays
 * coherent without the caller managing any of it.
 */
import { generate as helperGenerate } from './helper.js';
import { type ChatBackend,LiveSession } from './liveSession.js';
import { estimateConversationTokens, flattenMessages } from './protocol.js';
import type { PermissionPolicy, ToolRegistry } from './tools/index.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message } from './types.js';

/** Pluggable one-shot generation, used for summarization (a stub in tests). */
export type GenerateFn = (
  system: string,
  messages: Message[],
  onDelta?: DeltaHandler,
) => Promise<string>;

/** Configuration for a {@link ChatSession}. */
export interface ChatSessionConfig {
  /** Instructions for the model (system prompt). */
  system?: string;
  /** Generation knobs forwarded to every turn. */
  options?: GenerateOptions;
  /**
   * Compact the transcript once its estimated size (system + summary + turns)
   * exceeds this many tokens. The on-device window is ~4k; default 3000 leaves
   * headroom for the summarization turn itself.
   */
  compactAtTokens?: number;
  /** Number of most-recent turns kept verbatim through a compaction (default 4). */
  keepRecentTurns?: number;
  /** Helper discovery / timeout options (used for the default backend + summarizer). */
  helper?: HelperOptions;
  /** Tools the model may call mid-turn (FR-14). Ignored when a custom `backend` is set. */
  tools?: ToolRegistry;
  /** Per-call permission policy for tools (FR-14 phase 2). Ignored when a custom `backend` is set. */
  permission?: PermissionPolicy;
  /** Override the live-session backend (tests inject a fake here). */
  backend?: ChatBackend;
  /** Override the one-shot summarization backend (tests inject a stub here). */
  generateFn?: GenerateFn;
}

const DEFAULT_COMPACT_AT = 3000;
const DEFAULT_KEEP_RECENT = 4;

const SUMMARIZE_SYSTEM =
  'You compress conversations. Given a transcript, produce a terse third-person ' +
  'summary that preserves facts, decisions, names, and open questions needed to ' +
  'continue the conversation. Output only the summary prose.';

/** Default one-shot backend (summarization): spawn the real Swift helper. */
function defaultGenerateFn(helper: HelperOptions | undefined, options: GenerateOptions | undefined): GenerateFn {
  return (system, messages, onDelta) =>
    helperGenerate({ system, messages, options, stream: onDelta !== undefined }, helper, onDelta);
}

/**
 * A stateful, auto-compacting conversation with the on-device model. Turns run
 * against a persistent {@link LiveSession} (one `LanguageModelSession` reused
 * across turns, FR-12) rather than replaying the transcript each turn; the
 * transcript is still held here to drive compaction, history, and reseed.
 */
export class ChatSession {
  private system: string;
  private readonly compactAtTokens: number;
  private readonly keepRecentTurns: number;
  private readonly backend: ChatBackend;
  private readonly generateFn: GenerateFn;
  private messages: Message[] = [];
  /** Recap of turns dropped by compaction; folded into the system prompt. */
  private summary: string | undefined;
  /** Instructions the backend was last `reset` with (`undefined` ⇒ needs reset). */
  private backendInstructions: string | undefined;

  constructor(config: ChatSessionConfig = {}) {
    this.system = config.system ?? '';
    this.compactAtTokens = config.compactAtTokens ?? DEFAULT_COMPACT_AT;
    this.keepRecentTurns = config.keepRecentTurns ?? DEFAULT_KEEP_RECENT;
    this.backend =
      config.backend ??
      new LiveSession({
        ...config.helper,
        options: config.options,
        tools: config.tools,
        permission: config.permission,
      });
    this.generateFn = config.generateFn ?? defaultGenerateFn(config.helper, config.options);
  }

  /** The system prompt actually sent to the model (instructions + any recap). */
  private effectiveSystem(): string {
    if (this.summary === undefined) return this.system;
    const recap = `Conversation so far:\n${this.summary}`;
    return this.system.length > 0 ? `${this.system}\n\n${recap}` : recap;
  }

  /** The current transcript (a copy; mutating it does not affect the session). */
  history(): Message[] {
    return this.messages.map((message) => ({ ...message }));
  }

  /** Whether the next turn would push the transcript past the compaction bound. */
  shouldCompact(): boolean {
    return estimateConversationTokens(this.effectiveSystem(), this.messages) > this.compactAtTokens;
  }

  /**
   * Send a user turn and return the assistant's reply (streamed via `onDelta`). An
   * optional `signal` interrupts the turn (FR-15, esc-to-interrupt): on abort the
   * reply resolves with the partial text generated so far, and both the user prompt
   * and that partial reply are kept in history (so a follow-up turn stays coherent).
   */
  async send(text: string, onDelta?: DeltaHandler, signal?: AbortSignal): Promise<string> {
    if (this.shouldCompact()) await this.compact();
    // Re-establish the backend's context (first turn, or after a compaction
    // changed the effective system prompt) *before* recording the new turn, so the
    // reseed carries only prior turns.
    await this.ensureStarted();
    this.messages.push({ role: 'user', content: text });
    let reply: string;
    try {
      reply = await this.backend.send(text, onDelta, signal);
    } catch (error) {
      const overflow = isContextOverflow(error);
      if (!recoverable(error) && !overflow) {
        this.messages.pop();
        throw error;
      }
      // The in-flight turn failed recoverably; reseed a fresh session from the
      // transcript so far (excluding the in-flight turn) and try once more.
      // `[contextWindowExceeded]`: the model overflowed despite our pre-send token
      // estimate — compact first so the retry actually fits. `[sessionClosed]`: the
      // helper merely died, so reseeding as-is is enough.
      this.messages.pop();
      if (overflow) await this.compact();
      this.backendInstructions = undefined;
      await this.ensureStarted();
      this.messages.push({ role: 'user', content: text });
      reply = await this.backend.send(text, onDelta, signal);
    }
    this.messages.push({ role: 'assistant', content: reply });
    return reply;
  }

  /**
   * Reset the backend's session whenever the effective system prompt changes (the
   * first turn, or after a compaction), seeding it with the transcript so far.
   */
  private async ensureStarted(): Promise<void> {
    const system = this.effectiveSystem();
    if (this.backendInstructions === system) return;
    await this.backend.reset(system, this.messages);
    this.backendInstructions = system;
  }

  /**
   * Fold all but the most recent turns into the rolling summary. Safe to call
   * directly; {@link send} calls it automatically when {@link shouldCompact}.
   */
  async compact(): Promise<void> {
    if (this.messages.length <= this.keepRecentTurns) return;
    const cutoff = this.messages.length - this.keepRecentTurns;
    const older = this.messages.slice(0, cutoff);
    const recent = this.messages.slice(cutoff);
    // Reuse flattenMessages so the labeled-turn format has a single source of
    // truth (it is also what the helper replays — see flattenMessages).
    const transcript = [
      this.summary !== undefined ? `Previous summary:\n${this.summary}` : '',
      flattenMessages(older),
    ]
      .filter((part) => part.length > 0)
      .join('\n\n');
    this.summary = (await this.generateFn(SUMMARIZE_SYSTEM, [{ role: 'user', content: transcript }])).trim();
    this.messages = recent;
  }

  /** Clear the transcript and summary; optionally replace the system prompt. */
  reset(system?: string): void {
    if (system !== undefined) this.system = system;
    this.messages = [];
    this.summary = undefined;
    // Force a backend reset on the next turn (the live session is recreated then).
    this.backendInstructions = undefined;
  }

  /** Tear down the underlying live session (kills the helper process). */
  close(): void {
    this.backend.close();
  }
}

/** A backend failure is recoverable when the live-session helper merely exited. */
function recoverable(error: unknown): boolean {
  return error instanceof Error && error.message.includes('[sessionClosed]');
}

/** A turn that overflowed the model's context window (vs our pre-send estimate). */
function isContextOverflow(error: unknown): boolean {
  return error instanceof Error && error.message.includes('[contextWindowExceeded]');
}
