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
import { estimateConversationTokens, flattenMessages } from './protocol.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message } from './types.js';

/** Pluggable generation function (real helper by default; a stub in tests). */
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
  /** Helper discovery / timeout options (ignored when `generateFn` is given). */
  helper?: HelperOptions;
  /** Override the generation backend (tests inject a stub here). */
  generateFn?: GenerateFn;
}

const DEFAULT_COMPACT_AT = 3000;
const DEFAULT_KEEP_RECENT = 4;

const SUMMARIZE_SYSTEM =
  'You compress conversations. Given a transcript, produce a terse third-person ' +
  'summary that preserves facts, decisions, names, and open questions needed to ' +
  'continue the conversation. Output only the summary prose.';

/** Default generation backend: spawn the real Swift helper. */
function defaultGenerateFn(helper: HelperOptions | undefined, options: GenerateOptions | undefined): GenerateFn {
  return (system, messages, onDelta) =>
    helperGenerate({ system, messages, options, stream: onDelta !== undefined }, helper, onDelta);
}

/** A stateful, auto-compacting conversation with the on-device model. */
export class ChatSession {
  private system: string;
  private readonly options: GenerateOptions | undefined;
  private readonly compactAtTokens: number;
  private readonly keepRecentTurns: number;
  private readonly generateFn: GenerateFn;
  private messages: Message[] = [];
  /** Recap of turns dropped by compaction; folded into the system prompt. */
  private summary: string | undefined;

  constructor(config: ChatSessionConfig = {}) {
    this.system = config.system ?? '';
    this.options = config.options;
    this.compactAtTokens = config.compactAtTokens ?? DEFAULT_COMPACT_AT;
    this.keepRecentTurns = config.keepRecentTurns ?? DEFAULT_KEEP_RECENT;
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

  /** Send a user turn and return the assistant's reply (streamed via `onDelta`). */
  async send(text: string, onDelta?: DeltaHandler): Promise<string> {
    if (this.shouldCompact()) await this.compact();
    this.messages.push({ role: 'user', content: text });
    const reply = await this.generateFn(this.effectiveSystem(), this.messages, onDelta);
    this.messages.push({ role: 'assistant', content: reply });
    return reply;
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
  }
}
