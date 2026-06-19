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

import { resolveHelperPath } from './helper.js';
import { splitLines } from './protocol.js';
import type { DeltaHandler, GenerateOptions, HelperOptions, Message } from './types.js';

const DEFAULT_TURN_TIMEOUT_MS = 120_000;

/** Construction options for a {@link LiveSession}. */
export interface LiveSessionConfig extends HelperOptions {
  /** Generation knobs forwarded with every turn. */
  options?: GenerateOptions;
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
  /** Send one user turn; prior turns stay in the session's context. */
  send(text: string, onDelta?: DeltaHandler): Promise<string>;
  /** Recreate the underlying session with new instructions + seed turns. */
  reset(system: string, seed: Message[]): Promise<void>;
  /** Tear down the backend. */
  close(): void;
}

export class LiveSession implements ChatBackend {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly options: GenerateOptions | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(config: LiveSessionConfig = {}) {
    this.command = resolveHelperPath(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.options = config.options;
  }

  /** Recreate the underlying session with new instructions + seed turns. */
  async reset(system: string, seed: Message[] = []): Promise<void> {
    await this.dispatch({ type: 'reset', system, seed }, undefined);
  }

  /** Send one user turn; prior turns stay in context. Streams via `onDelta`. */
  send(text: string, onDelta?: DeltaHandler): Promise<string> {
    return this.dispatch(
      { prompt: text, options: this.options, stream: onDelta !== undefined },
      onDelta,
    );
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

  private dispatch(command: Record<string, unknown>, onDelta: DeltaHandler | undefined): Promise<string> {
    const child = this.ensureChild();
    const id = String(this.nextId++);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`live session timed out after ${String(this.timeoutMs)}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, onDelta, acc: '', timer });
      child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
}
