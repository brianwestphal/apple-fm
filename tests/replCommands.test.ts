import { describe, expect, it, vi } from 'vitest';

import { handleChatCommand } from '../src/chat/commands.js';
import type { SavedChat } from '../src/session.js';

function setup() {
  const session = {
    reset: vi.fn(), compact: vi.fn(() => Promise.resolve()),
    usage: vi.fn((): Promise<{ tokens: number; contextSize?: number }> => Promise.resolve({ tokens: 128, contextSize: 1024 })),
    saveTranscript: vi.fn((): Promise<SavedChat> => Promise.reject(new Error('cannot save'))),
  };
  const write = vi.fn();
  const commands = { session, toolNames: ['read'], withGuidance: (text: string) => `Guide ${text}`, write };
  return { commands, session, write };
}

describe('REPL slash commands (AFM-XSSR1A)', () => {
  it('keeps ordinary prompts and unknown slash text available to the model', async () => {
    const { commands, write } = setup();
    for (const input of ['text', '/unknown', '/system', '/usage trailing']) {
      await expect(handleChatCommand(input, commands)).resolves.toBe(false);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('executes help, settings, usage, tools and compaction', async () => {
    const { commands, session, write } = setup();
    for (const command of ['/help', '/clear', '/system new', '/reset', '/tools', '/compact', '/usage']) {
      await expect(handleChatCommand(command, commands)).resolves.toBe(true);
    }
    expect(session.reset.mock.calls).toEqual([[], ['Guide new'], [undefined]]);
    expect(write).toHaveBeenCalledWith('tools: read\n');
    expect(write).toHaveBeenCalledWith('(compacted)\n');
    expect(write).toHaveBeenCalledWith('Context: 128 / 1024 tokens (13%)\n');
  });

  it('prints command failures and remains ready for input', async () => {
    const { commands, write } = setup();
    await expect(handleChatCommand('/save', commands)).resolves.toBe(true);
    await expect(handleChatCommand('/save example.json', commands)).resolves.toBe(true);
    expect(write.mock.calls).toEqual([['error: /save requires a file path\n'], ['error: cannot save\n']]);
  });
});
