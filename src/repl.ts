/**
 * Interactive chat REPL for `apple-fm chat`. A thin readline loop around
 * {@link ChatSession}: it streams replies to stdout and handles a few slash
 * commands. All conversation/compaction logic lives in `session.ts`.
 */
import { createInterface, emitKeypressEvents, type Interface as ReadlineInterface } from 'node:readline';

import { handleChatCommand } from './chat/commands.js';
import { ChatSession, type SavedChat } from './session.js';
import { type AskOutcome,type PermissionAsker, PermissionPolicy, sanitizeForPrompt, toolGuidancePrompt,type ToolRegistry } from './tools/index.js';
import type { GenerateOptions, ModelId } from './types.js';

/** Options for {@link runRepl}. */
export interface ReplOptions {
  saved?: SavedChat;
  model?: ModelId;
  system?: string;
  stream: boolean;
  compactAtTokens?: number;
  options?: GenerateOptions;
  /** Tools the model may call mid-turn (FR-14). */
  tools?: ToolRegistry;
  /** Pre-authorized tool rules (`tool` / `tool:keyPrefix`) — `--allow-tool`. */
  allowTools?: string[];
  /** Denied tool rules — `--deny-tool`. */
  denyTools?: string[];
  /** Auto-approve every tool call — `--yes` (use with care). */
  yes?: boolean;
}

/**
 * A permission prompt bound to readline: `Run <description>? [y/N/a(lways)]`.
 * `y` → once, `a`/`always` → remember, anything else → deny. Exported for tests
 * (the REPL itself is exercised via the e2e suite).
 */
export function readlineAsker(rl: ReadlineInterface): PermissionAsker {
  let tail = Promise.resolve<unknown>(undefined);
  let closed = false;
  let activeQuestion: AbortController | undefined;
  rl.once('close', () => {
    closed = true;
    activeQuestion?.abort();
  });
  return (request) => {
    const queued = tail.then<AskOutcome>(async () => {
      if (closed || request.signal?.aborted === true) return 'deny';
      const controller = new AbortController();
      activeQuestion = controller;
      const cancel = (): void => { controller.abort(); };
      request.signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await new Promise<AskOutcome>((resolve) => {
          controller.signal.addEventListener('abort', () => { resolve('deny'); }, { once: true });
          const prompt = `\nRun ${sanitizeForPrompt(request.description)}? [y/N/a(lways)] `;
          rl.question(prompt, { signal: controller.signal }, (answer) => {
            const a = answer.trim().toLowerCase();
            if (a === 'a' || a === 'always') resolve('always');
            else resolve(a === 'y' || a === 'yes' ? 'once' : 'deny');
          });
        });
      } catch {
        return 'deny';
      } finally {
        activeQuestion = undefined;
        request.signal?.removeEventListener('abort', cancel);
      }
    });
    tail = queued;
    return queued;
  };
}

/** Run the interactive chat loop until EOF or `/quit`. */
export async function runRepl(opts: ReplOptions): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Only prompt for permission on a real TTY; piped/non-interactive input gets no
  // asker, so `ask` denies — a script never silently runs a tool.
  const asker = process.stdin.isTTY ? readlineAsker(rl) : undefined;
  const permission =
    opts.tools !== undefined
      ? new PermissionPolicy({
          default: opts.yes === true ? 'allow' : 'ask',
          allow: opts.allowTools,
          deny: opts.denyTools,
          asker,
        })
      : undefined;
  // When tools are enabled, fold a tool-use preamble into the system prompt so the
  // small on-device model knows when to call a tool instead of refusing. Merged with
  // any user `-s`, and re-applied on /system and /reset <sys>.
  const guidance = opts.tools !== undefined ? toolGuidancePrompt(opts.tools) : '';
  const withGuidance = (userSystem: string | undefined): string | undefined => {
    if (guidance.length === 0) return userSystem;
    return userSystem !== undefined && userSystem.length > 0 ? `${userSystem}\n\n${guidance}` : guidance;
  };
  const session = new ChatSession({
    model: opts.model,
    system: withGuidance(opts.system),
    options: opts.options,
    compactAtTokens: opts.compactAtTokens,
    tools: opts.tools,
    permission,
  });
  if (opts.saved !== undefined) {
    rl.pause();
    try {
      await session.resumeTranscript(opts.saved);
      rl.resume();
    } catch (error) {
      session.close();
      rl.close();
      throw error;
    }
  }
  process.stdout.write("apple-fm chat — Ctrl-D or /quit to quit, /help for commands.\n");

  // Esc interrupts the in-flight reply (FR-15). Only on a real TTY (keypress events
  // need raw mode); piped/non-interactive input has no keypress stream, so interrupt
  // is simply inactive there. `active` is set only while a turn is streaming.
  let active: AbortController | undefined;
  const terminal = { closed: false };
  const terminalClosed = (): boolean => terminal.closed;
  const prompt = (): void => { if (!terminalClosed()) rl.prompt(); };
  const onKeypress = (_str: string | undefined, key: { name?: string } | undefined): void => {
    if (key?.name === 'escape') active?.abort();
  };
  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', onKeypress);
    rl.once('close', () => {
      terminal.closed = true;
      active?.abort();
    });
  }

  rl.setPrompt('> ');
  prompt();

  const commands = {
    session,
    withGuidance,
    toolNames: opts.tools?.names() ?? [],
    write: (text: string): void => { process.stdout.write(text); },
  };
  for await (const line of rl) {
    if (terminalClosed()) break;
    const text = line.trim();
    if (text.length === 0) {
      prompt();
      continue;
    }
    if (text === '/quit' || text === '/exit') break;
    if (await handleChatCommand(text, commands)) {
      prompt();
      continue;
    }
    if (terminalClosed()) break;

    const controller = new AbortController();
    active = controller;
    try {
      const reply = await session.send(
        text,
        opts.stream ? (chunk) => process.stdout.write(chunk) : undefined,
        controller.signal,
      );
      if (controller.signal.aborted) {
        process.stdout.write('\n(interrupted)\n');
      } else {
        if (!opts.stream) process.stdout.write(reply);
        // The model can return nothing — e.g. it stops right after a tool call. Say so
        // rather than printing a blank line that looks like the command did nothing.
        if (reply.trim().length === 0) process.stdout.write('(no response)');
        process.stdout.write('\n');
      }
    } catch (error) {
      process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      active = undefined;
    }
    prompt();
  }

  if (process.stdin.isTTY) process.stdin.off('keypress', onKeypress);
  rl.close();
  // Tear down the persistent live-session helper process.
  session.close();
}
