import { writeSavedChat } from '../chatFile.js';
import type { ChatSession } from '../session.js';

const HELP = `Commands:
  /reset [system]   Start over (optionally set new system instructions)
  /system <text>    Replace the system instructions and reset
  /clear            Clear the conversation context (keep system instructions)
  /compact          Compact the conversation context now
  /usage            Show the current context token count
  /save <file>      Save the native transcript to a new file
  /tools            List the tools the model may call
  /help             Show this help
  /quit             Quit (alias /exit, or Ctrl-D)

  Press Esc while the model is replying to interrupt it (keeps the partial reply).`;

interface ChatCommands {
  session: Pick<ChatSession, 'compact' | 'reset' | 'saveTranscript' | 'usage'>;
  toolNames: string[];
  withGuidance: (system: string) => string | undefined;
  write: (text: string) => void;
}

/** Handle the REPL's slash commands. Other input remains a model prompt. */
export async function handleChatCommand(text: string, commands: ChatCommands): Promise<boolean> {
  const { session, toolNames, withGuidance, write } = commands;
  const space = text.indexOf(' ');
  const command = space === -1 ? text : text.slice(0, space);
  const argument = space === -1 ? undefined : text.slice(space + 1).trim();
  try {
    switch (command) {
      case '/help':
        if (argument !== undefined) return false;
        write(`${HELP}\n`);
        break;
      case '/clear':
        if (argument !== undefined) return false;
        session.reset();
        write('(context cleared)\n');
        break;
      case '/usage': {
        if (argument !== undefined) return false;
        const { tokens, contextSize } = await session.usage();
        if (contextSize === undefined) write(`Context: ~${String(tokens)} tokens (estimate)\n`);
        else write(`Context: ${String(tokens)} / ${String(contextSize)} tokens (${String(Math.round(tokens / contextSize * 100))}%)\n`);
        break;
      }
      case '/compact':
        if (argument !== undefined) return false;
        await session.compact();
        write('(compacted)\n');
        break;
      case '/save':
        if (argument === undefined || argument.length === 0) throw new Error('/save requires a file path');
        await writeSavedChat(argument, await session.saveTranscript());
        write('(saved)\n');
        break;
      case '/tools':
        if (argument !== undefined) return false;
        write(toolNames.length > 0 ? `tools: ${toolNames.join(', ')}\n` : '(no tools enabled)\n');
        break;
      case '/reset':
        session.reset(argument !== undefined && argument.length > 0 ? withGuidance(argument) : undefined);
        write('(reset)\n');
        break;
      case '/system':
        if (argument === undefined) return false;
        session.reset(withGuidance(argument));
        write('(system updated, conversation reset)\n');
        break;
      default:
        return false;
    }
  } catch (error) {
    write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return true;
}
