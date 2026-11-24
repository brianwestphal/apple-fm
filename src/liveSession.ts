/**
 * A persistent live session backed by one long-lived `apple-fm-helper --session`
 * process. Turns reuse the model's KV-cache instead of replaying the whole
 * transcript each turn (FR-12; see docs/7-live-session.md). The helper is spawned
 * lazily and respawned if it exits; callers re-establish context with `reset`.
 *
 * Commands and events are correlated by an `id` this class assigns, so the single
 * stdout stream can be demultiplexed back to the awaiting `send` / `reset`.
 */
import { type ChildProcessWithoutNullStreams,spawn } from 'node:child_process';

import { assertSupportedModel, isPlatformSupported, resolveHelperPath, unsupportedPlatformError, usingBundledHelper } from './helper.js';
import { parseTokenCount, splitLines } from './protocol.js';
import { dispatchToolCall } from './tools/dispatch.js';
import { PermissionPolicy, type ToolRegistry } from './tools/index.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message, ModelId } from './types.js';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Construction options for a {@link LiveSession}. */
export interface LiveSessionConfig extends HelperOptions {
  /** Model to use for the lifetime of the session. Defaults to on-device. */
  model?: ModelId;
  /** Generation knobs forwarded with every turn. */
  options?: GenerateOptions;
  /**
   * Tools the model may call mid-turn (FR-14). When non-empty, their definitions
   * are sent with each turn and the session dispatches `tool_call` events to them.
   */
  tools?: ToolRegistry;
  /**
   * Per-call permission policy consulted before each tool runs (FR-14 phase 2).
   *
   * **Safe by default (AFM-78):** when {@link tools} are registered and this is
   * omitted, the session installs a **fail-closed** policy (default `ask`, no asker ⇒
   * every tool call is denied) rather than running tools ungated. So a `tool_call` —
   * including one emitted by a compromised/replaced helper — never runs without an
   * explicit decision. To actually let tools run, supply a policy with `allow` rules,
   * an interactive `asker`, or `{ default: 'allow' }` (a deliberate opt-in; a `dangerous`
   * tool like `bash` still requires an explicit allow — AFM-64). A refused call is fed
   * back to the model as the tool result.
   */
  permission?: PermissionPolicy;
}

interface Pending {
  child: ChildProcessWithoutNullStreams;
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  onDelta: DeltaHandler | undefined;
  acc: string;
  timer?: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
  interrupted?: boolean;
}

/** The backend contract that `ChatSession` drives. */
export interface ChatBackend {
  /**
   * Send one user turn; prior turns stay in the session's context. An optional
   * `signal` interrupts the in-flight turn (FR-15, esc-to-interrupt): on abort the
   * turn is cancelled and resolves with the partial text generated so far.
   */
  send(text: string, onDelta?: DeltaHandler, signal?: AbortSignal): Promise<string>;
  /** Recreate the underlying session with new instructions + seed turns. */
  reset(system: string, seed: Message[]): Promise<void>;
  /** Native token budget for the active transcript plus the next prompt, if supported. */
  tokenBudget?(prompt: string): Promise<{ tokens: number; contextSize: number } | undefined>;
  /** Serialize the active native transcript, when the backend supports it. */
  exportTranscript?(): Promise<string>;
  /** Replace the native transcript after validating it against the enabled tools. */
  importTranscript?(transcript: string): Promise<void>;
  /** Tear down the backend. */
  close(): void;
}

export class LiveSession implements ChatBackend {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly options: GenerateOptions | undefined;
  private readonly tools: ToolRegistry | undefined;
  private readonly permission: PermissionPolicy | undefined;
  /** Whether we'd spawn the bundled macOS helper (subject to the platform gate). */
  private readonly bundled: boolean;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private contextSize?: number;
  private transcriptPersistence = false;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(config: LiveSessionConfig = {}) {
    this.command = resolveHelperPath(config);
    assertSupportedModel(config.model);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.options = config.options;
    this.tools = config.tools !== undefined && config.tools.size > 0 ? config.tools : undefined;
    // Safe by default (AFM-78): if tools are registered but no policy was supplied, fall
    // back to a fail-closed policy (default `ask`, no asker ⇒ deny) so tools are never
    // run ungated. An explicit policy — including a deliberate `{ default: 'allow' }` —
    // overrides this.
    this.permission = config.permission ?? (this.tools !== undefined ? new PermissionPolicy() : undefined);
    this.bundled = usingBundledHelper(config);
  }

  /**
   * Recreate the underlying session with new instructions + seed turns. Tool
   * definitions ride on `reset` because the framework binds tools at session
   * construction (not per turn); the helper builds the session's tools here.
   */
  async reset(system: string, seed: Message[] = []): Promise<void> {
    await this.dispatch(
      {
        type: 'reset',
        system,
        seed,
        // Only attach tools when some are registered, so resets stay byte-identical
        // to the no-tools path otherwise.
        ...(this.tools !== undefined ? { tools: this.tools.definitions() } : {}),
      },
      undefined,
    );
  }

  /**
   * Send one user turn; prior turns stay in context. Streams via `onDelta`. An
   * optional `signal` interrupts the turn: on abort a `cancel` command is sent and
   * the helper ends the turn with the partial text generated so far (FR-15).
   */
  send(text: string, onDelta?: DeltaHandler, signal?: AbortSignal): Promise<string> {
    return this.dispatch({ prompt: text, options: this.options, stream: onDelta !== undefined }, onDelta, signal);
  }

  /** Count native tokens for the active session without starting another helper. */
  async tokenBudget(prompt: string): Promise<{ tokens: number; contextSize: number } | undefined> {
    const contextSize = this.contextSize;
    const child = this.child;
    if (contextSize === undefined || child === undefined || child.exitCode !== null || child.killed) return undefined;
    try {
      const content = await this.dispatch({ type: 'count_tokens', prompt }, undefined);
      return { tokens: parseTokenCount(JSON.parse(content)), contextSize };
    } catch {
      return undefined;
    }
  }

  /** Serialize the active native transcript without starting another helper. */
  exportTranscript(): Promise<string> {
    this.requireTranscriptPersistence();
    return this.dispatch({ type: 'export_transcript' }, undefined);
  }

  /** Restore the transcript using the currently configured tools. */
  async importTranscript(transcript: string): Promise<void> {
    this.requireTranscriptPersistence();
    await this.dispatch({ type: 'import_transcript', content: transcript, tools: this.tools?.definitions() }, undefined);
  }

  private requireTranscriptPersistence(): void {
    const child = this.child;
    if (!this.transcriptPersistence || child === undefined || child.exitCode !== null || child.killed) {
      throw new Error('native transcript persistence requires a current apple-fm helper');
    }
  }

  /** Tear down the helper process and reject any in-flight commands. */
  close(): void {
    const child = this.child;
    if (child !== undefined) this.retireChild(child, new Error('[sessionClosed] live session closed'));
  }

  private retireChild(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.contextSize = undefined;
    this.transcriptPersistence = false;
    child.kill('SIGKILL');
    for (const id of this.pending.keys()) {
      this.takePending(id)?.reject(error);
    }
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    const existing = this.child;
    if (existing !== undefined && existing.exitCode === null && !existing.killed) return existing;
    if (existing !== undefined) this.retireChild(existing, new Error('[sessionClosed] live session helper exited'));
    const child = spawn(this.command, ['--session'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child === child) this.onStdout(child, chunk);
    });
    child.stdin.on('error', () => undefined); // swallow EPIPE if the helper exits early
    const onGone = (): void => {
      this.retireChild(child, new Error('[sessionClosed] live session helper exited'));
    };
    child.on('close', onGone);
    child.on('error', onGone);
    this.child = child;
    return child;
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: string): void {
    this.buffer += chunk;
    const { lines, rest } = splitLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      if (this.child !== child) return;
      this.onLine(child, line);
    }
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const event = value as Record<string, unknown>;
    if (typeof event.id !== 'string') {
      // Startup can fail before the helper reads a command ID.
      if (event.type === 'error' && typeof event.code === 'string' && typeof event.message === 'string') {
        this.retireChild(child, new Error(`[${event.code}] ${event.message}`));
      }
      return;
    }
    const id = event.id;
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    switch (event.type) {
      case 'delta':
        if (typeof event.text === 'string') {
          pending.acc += event.text;
          pending.onDelta?.(event.text);
        }
        break;
      case 'tool_call':
        // A tool the model invoked mid-turn. Run it (in Node) and write the result
        // back; the turn stays pending until its eventual `result`/`error`. Fire and
        // forget — the method never rejects (it writes a `tool_error` on any failure).
        void this.handleToolCall(id, pending, event);
        break;
      case 'ready':
        this.transcriptPersistence = event.transcriptPersistence === true;
        this.contextSize =
          typeof event.contextSize === 'number' && Number.isSafeInteger(event.contextSize) && event.contextSize > 0
            ? event.contextSize
            : undefined;
        this.settle(id, '');
        break;
      case 'result':
        this.settle(id, typeof event.content === 'string' ? event.content : pending.acc);
        break;
      case 'error':
        this.fail(id, `[${String(event.code)}] ${String(event.message)}`);
        break;
      default:
        break;
    }
  }

  /**
   * Dispatch a `tool_call` to the registered tool and write the outcome back to the
   * helper, keyed by `callId`. Runs concurrently with the still-open turn; the tool
   * policy lives in {@link dispatchToolCall} (`src/tools/dispatch.ts`) — this wires it
   * to the session's child process and the pending turn's timeout.
   */
  private handleToolCall(id: string, pending: Pending, event: Record<string, unknown>): Promise<void> {
    const isCurrent = (): boolean => this.child === pending.child && this.pending.get(id) === pending
      && pending.interrupted !== true && pending.child.exitCode === null && pending.child.signalCode === null;
    return dispatchToolCall(event, {
      tools: this.tools,
      permission: this.permission,
      isCurrent,
      send: (command) => {
        if (isCurrent()) pending.child.stdin.write(JSON.stringify(command) + '\n');
      },
      // Hold the turn open while the tool (and any permission prompt) runs.
      keepAlive: () => {
        if (isCurrent()) this.restartTimer(id, pending);
      },
    });
  }

  /** Restart a pending turn's timeout (e.g. across a tool call). */
  private restartTimer(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this.child !== pending.child || this.pending.get(id) !== pending) return;
      this.fail(id, `live session timed out after ${String(this.timeoutMs)}ms`);
      this.retireChild(pending.child, new Error('[sessionClosed] live session helper terminated after a command timed out'));
    }, this.timeoutMs);
  }

  private takePending(id: string): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    this.pending.delete(id);
    return pending;
  }

  private settle(id: string, content: string): void {
    this.takePending(id)?.resolve(content);
  }

  private fail(id: string, message: string): void {
    this.takePending(id)?.reject(new Error(message));
  }

  private dispatch(
    command: Record<string, unknown>,
    onDelta: DeltaHandler | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted === true) return Promise.resolve('');
    // Off-platform the bundled macOS helper can't run — fail with a clear error
    // rather than spawning it and surfacing a raw [sessionClosed].
    if (this.bundled && !isPlatformSupported()) return Promise.reject(unsupportedPlatformError());
    const child = this.ensureChild();
    const id = String(this.nextId++);
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = { child, resolve, reject, onDelta, acc: '' };
      this.pending.set(id, pending);
      this.restartTimer(id, pending);
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
      // Interrupt (FR-15): tell the helper to cancel this turn; it ends by emitting a
      // `result` with the partial text, which settles the pending promise normally.
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (this.pending.get(id) !== pending) return;
          pending.interrupted = true;
          child.stdin.write(JSON.stringify({ type: 'cancel', id }) + '\n');
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.removeAbortListener = () => { signal.removeEventListener('abort', onAbort); };
      }
    });
  }
}
