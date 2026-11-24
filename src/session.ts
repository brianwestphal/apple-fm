/**
 * A multi-turn chat session over the selected model, with automatic context
 * compaction.
 *
 * The on-device model has a small context window, so a long conversation will
 * eventually overflow it. {@link ChatSession} holds the transcript on the Node
 * side and, when the estimated size crosses a threshold, summarizes the older
 * turns into a compact recap (using the same model) and continues with
 * that recap plus the most recent turns kept verbatim. The conversation stays
 * coherent without the caller managing any of it.
 */
import { generate as helperGenerate } from './helper.js';
import { type ChatBackend,LiveSession, type LiveSessionConfig } from './liveSession.js';
import { estimateConversationTokens, flattenMessages } from './protocol.js';
import type { PermissionPolicy, ToolRegistry } from './tools/index.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message, ModelId } from './types.js';

/** Pluggable one-shot generation, used for summarization (a stub in tests). */
export type GenerateFn = (
  system: string,
  messages: Message[],
  onDelta?: DeltaHandler,
) => Promise<string>;

/** Versioned snapshot for saving and resuming a chat. */
export interface SavedChat {
  version: 1;
  system: string;
  summary?: string;
  messages: Message[];
  tools: string[];
  transcript: string;
}

/** Read and validate an apple-fm chat snapshot before sending it to the helper. */
export function parseSavedChat(text: string): SavedChat {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1) {
    throw new Error('unsupported apple-fm chat file version');
  }
  const record = value as Record<string, unknown>;
  const { system, summary, messages, tools, transcript } = record;
  if (
    typeof system !== 'string' ||
    (summary !== undefined && typeof summary !== 'string') ||
    typeof transcript !== 'string' ||
    !Array.isArray(tools) || !tools.every((tool: unknown): tool is string => typeof tool === 'string') ||
    !Array.isArray(messages) || !messages.every(isSavedMessage)
  ) {
    throw new Error('invalid apple-fm chat file');
  }
  return { version: 1, system, summary, messages, tools, transcript };
}

function isSavedMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && 'role' in value &&
    (value.role === 'user' || value.role === 'assistant') &&
    'content' in value && typeof value.content === 'string';
}

/** Configuration for a {@link ChatSession}. */
export interface ChatSessionConfig {
  /** Model used for chat and compaction. Defaults to on-device. */
  model?: ModelId;
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
  /** Observe tool activity from the default live backend. */
  onToolActivity?: LiveSessionConfig['onToolActivity'];
  /**
   * Per-call permission policy for tools (FR-14 phase 2). Ignored when a custom
   * `backend` is set. Safe by default: with `tools` set but no policy, the default
   * live-session backend installs a **fail-closed** policy (all tool calls denied) —
   * supply a policy with `allow` rules / an `asker` / `{ default: 'allow' }` to let tools
   * run (AFM-78).
   */
  permission?: PermissionPolicy;
  /** Override the live-session backend (tests inject a fake here). */
  backend?: ChatBackend;
  /** Override the one-shot summarization backend (tests inject a stub here). */
  generateFn?: GenerateFn;
}

const DEFAULT_COMPACT_AT = 3000;
const DEFAULT_KEEP_RECENT = 4;
const CONTEXT_COMPACTION_FRACTION = 0.75;

const SUMMARIZE_SYSTEM =
  'You compress conversations. Given a transcript, produce a terse third-person ' +
  'summary that preserves facts, decisions, names, and open questions needed to ' +
  'continue the conversation. Output only the summary prose.';

/** Default one-shot backend (summarization): spawn the real Swift helper. */
function defaultGenerateFn({ model, helper, options }: ChatSessionConfig): GenerateFn {
  return (system, messages, onDelta) =>
    helperGenerate(
      { model, system, messages, options, stream: onDelta !== undefined },
      helper,
      onDelta,
    );
}

/**
 * A stateful, auto-compacting conversation with the selected model. Turns run
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
  private readonly toolNames: string[];
  private messages: Message[] = [];
  /** Recap of turns dropped by compaction; folded into the system prompt. */
  private summary: string | undefined;
  /** Instructions the backend was last `reset` with (`undefined` ⇒ needs reset). */
  private backendInstructions: string | undefined;
  private operations = Promise.resolve();
  private revision = 0;

  constructor(config: ChatSessionConfig = {}) {
    this.system = config.system ?? '';
    this.toolNames = config.tools?.names().sort() ?? [];
    this.compactAtTokens = config.compactAtTokens ?? DEFAULT_COMPACT_AT;
    this.keepRecentTurns = config.keepRecentTurns ?? DEFAULT_KEEP_RECENT;
    this.backend =
      config.backend ??
      new LiveSession({
        ...config.helper,
        model: config.model,
        options: config.options,
        tools: config.tools,
        permission: config.permission,
        onToolActivity: config.onToolActivity,
      });
    this.generateFn = config.generateFn ?? defaultGenerateFn(config);
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

  /** Report the active context in tokens. A missing capacity indicates an estimate. */
  usage(): Promise<{ tokens: number; contextSize?: number }> {
    return this.schedule(async (revision) => {
      await this.ensureStarted(revision);
      this.assertCurrent(revision);
      const budget = await this.backend.tokenBudget?.('');
      this.assertCurrent(revision);
      return budget ?? { tokens: estimateConversationTokens(this.effectiveSystem(), this.messages) };
    });
  }

  /** Whether the next turn would push the transcript past the compaction bound. */
  shouldCompact(): boolean {
    return estimateConversationTokens(this.effectiveSystem(), this.messages) > this.compactAtTokens;
  }

  /**
   * Send a user turn and return the assistant's reply (streamed via `onDelta`). An
   * optional `signal` interrupts the turn (FR-15, esc-to-interrupt): on abort the
   * reply resolves with the partial text generated so far, and both the user prompt
   * and that partial reply are kept in history. Aborting before a turn starts
   * returns empty text without adding a turn.
   */
  send(text: string, onDelta?: DeltaHandler, signal?: AbortSignal): Promise<string> {
    return this.schedule((revision) => this.sendTurn(revision, text, onDelta, signal));
  }

  private async sendTurn(revision: number, text: string, onDelta?: DeltaHandler, signal?: AbortSignal): Promise<string> {
    const interrupted = (): boolean => signal?.aborted === true;
    if (interrupted()) return '';
    const stream = onDelta === undefined ? undefined : (chunk: string): void => {
      if (revision === this.revision) onDelta(chunk);
    };
    if (this.messages.length > this.keepRecentTurns) {
      const budget = this.backendInstructions === this.effectiveSystem()
        ? await this.backend.tokenBudget?.(text)
        : undefined;
      this.assertCurrent(revision);
      const shouldCompact = budget === undefined
        ? this.shouldCompact()
        : budget.tokens > Math.min(this.compactAtTokens, Math.floor(budget.contextSize * CONTEXT_COMPACTION_FRACTION));
      if (shouldCompact) await this.compactHistory(revision);
    }
    // Re-establish the backend's context (first turn, or after a compaction
    // changed the effective system prompt) *before* recording the new turn, so the
    // reseed carries only prior turns.
    await this.ensureStarted(revision);
    if (interrupted()) return '';
    let reply: string;
    try {
      reply = await this.runBackend(revision, () => this.backend.send(text, stream, signal));
    } catch (error) {
      this.assertCurrent(revision);
      const overflow = isContextOverflow(error);
      if (!recoverable(error) && !overflow) throw error;
      // The in-flight turn failed recoverably; reseed a fresh session from the
      // transcript so far (excluding the in-flight turn) and try once more.
      // `[contextWindowExceeded]`: the model overflowed despite our pre-send token
      // estimate — compact first so the retry actually fits. `[sessionClosed]`: the
      // helper merely died, so reseeding as-is is enough.
      if (overflow) await this.compactHistory(revision);
      await this.ensureStarted(revision);
      if (interrupted()) return '';
      reply = await this.runBackend(revision, () => this.backend.send(text, stream, signal));
    }
    this.assertCurrent(revision);
    this.messages.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    return reply;
  }

  /**
   * Reset the backend's session whenever the effective system prompt changes (the
   * first turn, or after a compaction), seeding it with the transcript so far.
   */
  private async ensureStarted(revision: number): Promise<void> {
    this.assertCurrent(revision);
    const system = this.effectiveSystem();
    if (this.backendInstructions === system && this.backend.isActive?.() !== false) return;
    await this.runBackend(revision, () => this.backend.reset(system, this.history()));
    this.assertCurrent(revision);
    this.backendInstructions = system;
  }

  private async runBackend<T>(revision: number, operation: () => Promise<T>): Promise<T> {
    this.assertCurrent(revision);
    try {
      return await operation();
    } catch (error) {
      this.assertCurrent(revision);
      this.backendInstructions = undefined;
      throw error;
    }
  }

  private schedule<T>(operation: (revision: number) => Promise<T>): Promise<T> {
    const revision = this.revision;
    const scheduled = this.operations.then(() => {
      this.assertCurrent(revision);
      return operation(revision);
    });
    this.operations = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  private assertCurrent(revision: number): void {
    if (this.revision !== revision) throw new Error('chat session changed during the operation');
  }

  /**
   * Fold all but the most recent turns into the rolling summary. Safe to call
   * directly; {@link send} calls it automatically when {@link shouldCompact}.
   */
  compact(): Promise<void> {
    return this.schedule((revision) => this.compactHistory(revision));
  }

  private async compactHistory(revision: number): Promise<void> {
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
    const summary = await this.generateFn(SUMMARIZE_SYSTEM, [{ role: 'user', content: transcript }]);
    this.assertCurrent(revision);
    this.summary = summary.trim();
    this.messages = recent;
    this.backendInstructions = undefined;
  }

  /** Capture a versioned snapshot with the native session transcript. */
  saveTranscript(): Promise<SavedChat> {
    return this.schedule(async (revision) => {
      const exportTranscript = this.backend.exportTranscript?.bind(this.backend);
      if (exportTranscript === undefined) throw new Error('backend cannot save a native transcript');
      await this.ensureStarted(revision);
      const transcript = await this.runBackend(revision, exportTranscript);
      this.assertCurrent(revision);
      return {
        version: 1,
        system: this.system,
        summary: this.summary,
        messages: this.history(),
        tools: [...this.toolNames],
        transcript,
      };
    });
  }

  /** Resume a saved chat using this invocation's tool registry and permissions. */
  resumeTranscript(saved: SavedChat): Promise<void> {
    const { system, summary, transcript } = saved;
    const messages = saved.messages.map((message) => ({ ...message }));
    const tools = [...saved.tools].sort();
    return this.schedule(async (revision) => {
      const importTranscript = this.backend.importTranscript?.bind(this.backend);
      if (importTranscript === undefined) throw new Error('backend cannot resume a native transcript');
      if (JSON.stringify(this.toolNames) !== JSON.stringify(tools)) {
        throw new Error('enabled tools do not match the saved chat; use the same --tools list');
      }
      await this.ensureStarted(revision);
      await this.runBackend(revision, () => importTranscript(transcript));
      this.assertCurrent(revision);
      this.system = system;
      this.summary = summary;
      this.messages = messages;
      this.backendInstructions = this.effectiveSystem();
    });
  }

  /** Clear the transcript and summary; optionally replace the system prompt. */
  reset(system?: string): void {
    this.revision += 1;
    if (system !== undefined) this.system = system;
    this.messages = [];
    this.summary = undefined;
    // Force a backend reset on the next turn (the live session is recreated then).
    this.backendInstructions = undefined;
  }

  /** Tear down the underlying live session (kills the helper process). */
  close(): void {
    this.revision += 1;
    this.backendInstructions = undefined;
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
