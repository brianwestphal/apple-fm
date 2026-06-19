import { describe, expect, it } from 'vitest';

import { ChatSession, type GenerateFn } from '../src/session.js';
import type { Message } from '../src/types.js';

interface Call {
  system: string;
  messages: Message[];
  isSummarize: boolean;
}

/** A recording stub generator: summarization returns "SUMMARY", else "reply:<lastUser>". */
function recordingGen(): { gen: GenerateFn; calls: Call[] } {
  const calls: Call[] = [];
  const gen: GenerateFn = (system, messages, onDelta) => {
    const isSummarize = system.includes('compress conversations');
    calls.push({ system, messages: messages.map((m) => ({ ...m })), isSummarize });
    if (isSummarize) return Promise.resolve('SUMMARY');
    onDelta?.('chunk');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    return Promise.resolve(`reply:${lastUser?.content ?? ''}`);
  };
  return { gen, calls };
}

describe('ChatSession.send', () => {
  it('appends the user turn and the reply to history', async () => {
    const { gen, calls } = recordingGen();
    const session = new ChatSession({ system: 'sys', generateFn: gen, compactAtTokens: 1e9 });
    const reply = await session.send('hi');
    expect(reply).toBe('reply:hi');
    expect(session.history()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply:hi' },
    ]);
    expect(calls[0]).toMatchObject({ system: 'sys', isSummarize: false });
    expect(calls[0]?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('forwards streamed deltas', async () => {
    const { gen } = recordingGen();
    const session = new ChatSession({ generateFn: gen, compactAtTokens: 1e9 });
    const chunks: string[] = [];
    await session.send('hi', (c) => chunks.push(c));
    expect(chunks).toEqual(['chunk']);
  });

  it('history() returns a defensive copy', async () => {
    const { gen } = recordingGen();
    const session = new ChatSession({ generateFn: gen, compactAtTokens: 1e9 });
    await session.send('hi');
    const h = session.history();
    h.pop();
    expect(session.history()).toHaveLength(2);
  });
});

describe('ChatSession compaction', () => {
  it('folds older turns into a summary and keeps recent ones', async () => {
    const { gen, calls } = recordingGen();
    const session = new ChatSession({
      generateFn: gen,
      compactAtTokens: 0, // any non-empty transcript triggers compaction
      keepRecentTurns: 1,
    });
    await session.send('first'); // no compaction (transcript empty at entry)
    await session.send('second'); // compaction fires before this turn

    const summarize = calls.filter((c) => c.isSummarize);
    expect(summarize).toHaveLength(1);

    // The post-compaction generation carries the recap in its system prompt.
    const mainCalls = calls.filter((c) => !c.isSummarize);
    expect(mainCalls.at(-1)?.system).toContain('Conversation so far:\nSUMMARY');
  });

  it('compact() is a no-op when there is nothing older than keepRecentTurns', async () => {
    const { gen, calls } = recordingGen();
    const session = new ChatSession({ generateFn: gen, keepRecentTurns: 4, compactAtTokens: 1e9 });
    await session.send('hi');
    await session.compact();
    expect(calls.some((c) => c.isSummarize)).toBe(false);
  });
});

describe('ChatSession.reset', () => {
  it('clears history and optionally replaces the system prompt', async () => {
    const { gen, calls } = recordingGen();
    const session = new ChatSession({ system: 'old', generateFn: gen, compactAtTokens: 1e9 });
    await session.send('hi');
    session.reset('new');
    expect(session.history()).toEqual([]);
    await session.send('again');
    expect(calls.at(-1)?.system).toBe('new');
  });
});
