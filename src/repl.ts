/**
 * Interactive chat REPL for `apple-fm chat`. A thin readline loop around
 * {@link ChatSession}: it streams replies to stdout and handles a few slash
 * commands. All conversation/compaction logic lives in `session.ts`.
 */
import { createInterface } from 'node:readline';

import { ChatSession } from './session.js';
import type { ToolRegistry } from './tools/index.js';
import type { GenerateOptions } from './types.js';

/** Options for {@link runRepl}. */
export interface ReplOptions {
  system?: string;
  stream: boolean;
  compactAtTokens?: number;
  options?: GenerateOptions;
  /** Tools the model may call mid-turn (FR-14). */
  tools?: ToolRegistry;
}

const HELP = `Commands:
  /reset [system]   Start over (optionally set new system instructions)
  /system <text>    Replace the system instructions and reset
  /clear            Clear the conversation context (keep system instructions)
  /compact          Compact the conversation context now
  /help             Show this help
  /quit             Quit (alias /exit, or Ctrl-D)`;

/** Run the interactive chat loop until EOF or `/quit`. */
export async function runRepl(opts: ReplOptions): Promise<void> {
  const session = new ChatSession({
    system: opts.system,
    options: opts.options,
    compactAtTokens: opts.compactAtTokens,
    tools: opts.tools,
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write("apple-fm chat — Ctrl-D or /quit to quit, /help for commands.\n");

  rl.setPrompt('> ');
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (text.length === 0) {
      rl.prompt();
      continue;
    }
    if (text === '/quit' || text === '/exit') break;
    if (text === '/help') {
      process.stdout.write(`${HELP}\n`);
      rl.prompt();
      continue;
    }
    if (text === '/clear') {
      session.reset();
      process.stdout.write('(context cleared)\n');
      rl.prompt();
      continue;
    }
    if (text === '/compact') {
      try {
        await session.compact();
        process.stdout.write('(compacted)\n');
      } catch (error) {
        process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      rl.prompt();
      continue;
    }
    if (text === '/reset' || text.startsWith('/reset ')) {
      session.reset(text.slice('/reset'.length).trim() || undefined);
      process.stdout.write('(reset)\n');
      rl.prompt();
      continue;
    }
    if (text.startsWith('/system ')) {
      session.reset(text.slice('/system '.length).trim());
      process.stdout.write('(system updated, conversation reset)\n');
      rl.prompt();
      continue;
    }

    try {
      const reply = await session.send(text, opts.stream ? (chunk) => process.stdout.write(chunk) : undefined);
      if (!opts.stream) process.stdout.write(reply);
      process.stdout.write('\n');
    } catch (error) {
      process.stdout.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    rl.prompt();
  }

  rl.close();
  // Tear down the persistent live-session helper process.
  session.close();
}
