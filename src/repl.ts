/**
 * Interactive chat REPL for `apple-fm chat`. A thin readline loop around
 * {@link ChatSession}: it streams replies to stdout and handles a few slash
 * commands. All conversation/compaction logic lives in `session.ts`.
 */
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { ChatSession } from './session.js';
import { type PermissionAsker, PermissionPolicy, toolGuidancePrompt,type ToolRegistry } from './tools/index.js';
import type { GenerateOptions } from './types.js';

/** Options for {@link runRepl}. */
export interface ReplOptions {
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

const HELP = `Commands:
  /reset [system]   Start over (optionally set new system instructions)
  /system <text>    Replace the system instructions and reset
  /clear            Clear the conversation context (keep system instructions)
  /compact          Compact the conversation context now
  /tools            List the tools the model may call
  /help             Show this help
  /quit             Quit (alias /exit, or Ctrl-D)`;

/**
 * A permission prompt bound to readline: `Run <description>? [y/N/a(lways)]`.
 * `y` → once, `a`/`always` → remember, anything else → deny. Exported for tests
 * (the REPL itself is exercised via the e2e suite).
 */
export function readlineAsker(rl: ReadlineInterface): PermissionAsker {
  return (request) =>
    new Promise((resolve) => {
      rl.question(`\nRun ${request.description}? [y/N/a(lways)] `, (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === 'a' || a === 'always') resolve('always');
        else resolve(a === 'y' || a === 'yes' ? 'once' : 'deny');
      });
    });
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
    system: withGuidance(opts.system),
    options: opts.options,
    compactAtTokens: opts.compactAtTokens,
    tools: opts.tools,
    permission,
  });
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
    if (text === '/tools') {
      const names = opts.tools?.names() ?? [];
      process.stdout.write(names.length > 0 ? `tools: ${names.join(', ')}\n` : '(no tools enabled)\n');
      rl.prompt();
      continue;
    }
    if (text === '/reset' || text.startsWith('/reset ')) {
      const arg = text.slice('/reset'.length).trim();
      session.reset(arg.length > 0 ? withGuidance(arg) : undefined);
      process.stdout.write('(reset)\n');
      rl.prompt();
      continue;
    }
    if (text.startsWith('/system ')) {
      session.reset(withGuidance(text.slice('/system '.length).trim()));
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
