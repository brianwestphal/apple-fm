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

import { isPlatformSupported, resolveHelperPath, unsupportedPlatformError, usingBundledHelper } from './helper.js';
import { splitLines } from './protocol.js';
import { dispatchToolCall } from './tools/dispatch.js';
import type { PermissionPolicy, ToolRegistry } from './tools/index.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message } from './types.js';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Construction options for a {@link LiveSession}. */
export interface LiveSessionConfig extends HelperOptions {
  /** Generation knobs forwarded with every turn. */
  options?: GenerateOptions;
  /**
   * Tools the model may call mid-turn (FR-14). When non-empty, their definitions
   * are sent with each turn and the session dispatches `tool_call` events to them.
   */
  tools?: ToolRegistry;
  /**
   * Per-call permission policy consulted before each tool runs (FR-14 phase 2).
   * Omitted ⇒ tools run without a gate (registry-only). A refused call becomes a
   * `tool_error`.
   */
  permission?: PermissionPolicy;
}

interface Pending {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  onDelta: DeltaHandler | undefined;
  acc: string;
  timer: ReturnType<typeof setTimeout>;
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
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(config: LiveSessionConfig = {}) {
    this.command = resolveHelperPath(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.options = config.options;
    this.tools = config.tools !== undefined && config.tools.size > 0 ? config.tools : undefined;
    this.permission = config.permission;
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

  /** Tear down the helper process and reject any in-flight commands. */
  close(): void {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined) child.kill('SIGKILL');
    this.rejectAll(new Error('[sessionClosed] live session closed'));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    const existing = this.child;
    if (existing !== undefined && existing.exitCode === null && !existing.killed) return existing;
    const child = spawn(this.command, ['--session'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.onStdout(chunk);
    });
    child.stdin.on('error', () => undefined); // swallow EPIPE if the helper exits early
    const onGone = (): void => {
      if (this.child === child) this.child = undefined;
      this.rejectAll(new Error('[sessionClosed] live session helper exited'));
    };
    child.on('close', onGone);
    child.on('error', onGone);
    this.child = child;
    return child;
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    const { lines, rest } = splitLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) this.onLine(line);
  }

  private onLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const event = value as Record<string, unknown>;
    if (typeof event.id !== 'string') return; // session events always carry an id
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
    return dispatchToolCall(event, {
      tools: this.tools,
      permission: this.permission,
      send: (command) => {
        this.child?.stdin.write(JSON.stringify(command) + '\n');
      },
      // Hold the turn open while the tool (and any permission prompt) runs.
      keepAlive: () => {
        this.restartTimer(id, pending);
      },
    });
  }

  /** Restart a pending turn's timeout (e.g. across a tool call). */
  private restartTimer(id: string, pending: Pending): void {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.fail(id, `live session timed out after ${String(this.timeoutMs)}ms`);
    }, this.timeoutMs);
  }

  private settle(id: string, content: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve(content);
  }

  private fail(id: string, message: string): void {
    const pending = this.pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.reject(new Error(message));
  }

  private dispatch(
    command: Record<string, unknown>,
    onDelta: DeltaHandler | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    // Off-platform the bundled macOS helper can't run — fail with a clear error
    // rather than spawning it and surfacing a raw [sessionClosed].
    if (this.bundled && !isPlatformSupported()) return Promise.reject(unsupportedPlatformError());
    const child = this.ensureChild();
    const id = String(this.nextId++);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`live session timed out after ${String(this.timeoutMs)}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, onDelta, acc: '', timer });
      // Interrupt (FR-15): tell the helper to cancel this turn; it ends by emitting a
      // `result` with the partial text, which settles the pending promise normally.
      if (signal !== undefined) {
        if (signal.aborted) this.cancel(id);
        else {
          signal.addEventListener(
            'abort',
            () => {
              this.cancel(id);
            },
            { once: true },
          );
        }
      }
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }

  /** Ask the helper to cancel an in-flight turn (no-op if it already settled). */
  private cancel(id: string): void {
    if (!this.pending.has(id)) return;
    this.child?.stdin.write(JSON.stringify({ type: 'cancel', id }) + '\n');
  }
}
