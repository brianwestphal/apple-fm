import { describe, expect, it } from 'vitest';

import type { ChatBackend } from '../src/liveSession.js';
import { ChatSession, type GenerateFn } from '../src/session.js';
import type { Message } from '../src/types.js';

type BackendCall =
  | { kind: 'reset'; system: string; seed: Message[] }
  | { kind: 'send'; text: string }
  | { kind: 'close' };

/**
 * A fake live-session backend: records reset/send/close, streams one "chunk",
 * and replies `reply:<text>`. `crashOnce` makes the first send throw a
 * `[sessionClosed]` error (to exercise ChatSession's reseed-and-retry).
 */
function recordingBackend(opts: { crashOn?: string; overflowOn?: string } = {}): {
  backend: ChatBackend;
  calls: BackendCall[];
} {
  const calls: BackendCall[] = [];
  let crashArmed = opts.crashOn !== undefined;
  let overflowArmed = opts.overflowOn !== undefined;
  const backend: ChatBackend = {
    reset(system, seed) {
      calls.push({ kind: 'reset', system, seed: seed.map((m) => ({ ...m })) });
      return Promise.resolve();
    },
    send(text, onDelta) {
      calls.push({ kind: 'send', text });
      if (crashArmed && text === opts.crashOn) {
        crashArmed = false;
        return Promise.reject(new Error('[sessionClosed] live session helper exited'));
      }
      if (overflowArmed && text === opts.overflowOn) {
        overflowArmed = false;
        return Promise.reject(new Error('[contextWindowExceeded] the model context window was exceeded'));
      }
      onDelta?.('chunk');
      return Promise.resolve(`reply:${text}`);
    },
    close() {
      calls.push({ kind: 'close' });
    },
  };
  return { backend, calls };
}

/** A one-shot summarizer stub: returns "SUMMARY" and records its calls. */
function recordingSummarizer(): { gen: GenerateFn; calls: { system: string; messages: Message[] }[] } {
  const calls: { system: string; messages: Message[] }[] = [];
  const gen: GenerateFn = (system, messages) => {
    calls.push({ system, messages: messages.map((m) => ({ ...m })) });
    return Promise.resolve('SUMMARY');
  };
  return { gen, calls };
}

describe('ChatSession.send', () => {
  it('resets the backend once, then sends turns; appends to history', async () => {
    const { backend, calls } = recordingBackend();
    const session = new ChatSession({ system: 'sys', backend, compactAtTokens: 1e9 });

    expect(await session.send('hi')).toBe('reply:hi');
    expect(await session.send('again')).toBe('reply:again');

    expect(session.history()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'reply:hi' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'reply:again' },
    ]);
    // One reset (first turn, empty seed); the second turn reuses the live session.
    expect(calls).toEqual([
      { kind: 'reset', system: 'sys', seed: [] },
      { kind: 'send', text: 'hi' },
      { kind: 'send', text: 'again' },
    ]);
  });

  it('forwards streamed deltas', async () => {
    const { backend } = recordingBackend();
    const session = new ChatSession({ backend, compactAtTokens: 1e9 });
    const chunks: string[] = [];
    await session.send('hi', (c) => chunks.push(c));
    expect(chunks).toEqual(['chunk']);
  });

  it('forwards an abort signal and keeps the partial reply in history (FR-15)', async () => {
    let seenSignal: AbortSignal | undefined;
    const backend: ChatBackend = {
      reset: () => Promise.resolve(),
      // The interrupted backend resolves with the partial text generated so far.
      send: (text, _onDelta, signal) => {
        seenSignal = signal;
        return Promise.resolve(signal?.aborted === true ? `partial:${text}` : `reply:${text}`);
      },
      close: () => undefined,
    };
    const session = new ChatSession({ backend, compactAtTokens: 1e9 });
    const controller = new AbortController();
    controller.abort();
    const reply = await session.send('hi', undefined, controller.signal);
    expect(seenSignal).toBe(controller.signal); // signal threaded through to the backend
    expect(reply).toBe('partial:hi');
    expect(session.history()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'partial:hi' }, // partial kept
    ]);
  });

  it('reseeds and retries once when the helper dies mid-turn', async () => {
    const { backend, calls } = recordingBackend({ crashOn: 'two' });
    const session = new ChatSession({ system: 'sys', backend, compactAtTokens: 1e9 });

    await session.send('one'); // succeeds: reset + send
    const reply = await session.send('two'); // send throws [sessionClosed], reseed + resend
    expect(reply).toBe('reply:two');

    // The retry reseeds from the transcript so far (the prior completed turn),
    // excluding the in-flight 'two', then resends.
    expect(calls).toEqual([
      { kind: 'reset', system: 'sys', seed: [] },
      { kind: 'send', text: 'one' },
      { kind: 'send', text: 'two' }, // crashes
      {
        kind: 'reset',
        system: 'sys',
        seed: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'reply:one' },
        ],
      },
      { kind: 'send', text: 'two' }, // succeeds
    ]);
    expect(session.history().at(-1)).toEqual({ role: 'assistant', content: 'reply:two' });
  });

  it('compacts and retries once when a turn overflows the context window', async () => {
    const { backend, calls } = recordingBackend({ overflowOn: 'big' });
    const summarizer = recordingSummarizer();
    const session = new ChatSession({
      system: 'sys',
      backend,
      generateFn: summarizer.gen,
      compactAtTokens: 1e9, // never compact proactively — force the reactive path
      keepRecentTurns: 1,
    });
    await session.send('one');
    await session.send('two'); // build a transcript so there is something to fold

    const reply = await session.send('big'); // overflows, compacts, reseeds, retries
    expect(reply).toBe('reply:big');

    // The overflow triggered a compaction (summarizer ran) even though the proactive
    // threshold was never crossed…
    expect(summarizer.calls).toHaveLength(1);
    // …and the retry reseeded a fresh session carrying the recap.
    const lastReset = [...calls].reverse().find((c) => c.kind === 'reset');
    expect(lastReset?.system).toContain('Conversation so far:\nSUMMARY');
    // The turn ultimately landed in history.
    expect(session.history().at(-1)).toEqual({ role: 'assistant', content: 'reply:big' });
  });

  it('history() returns a defensive copy', async () => {
    const { backend } = recordingBackend();
    const session = new ChatSession({ backend, compactAtTokens: 1e9 });
    await session.send('hi');
    session.history().pop();
    expect(session.history()).toHaveLength(2);
  });
});

describe('ChatSession compaction', () => {
  it('summarizes older turns and reseeds the backend with the recap + recent turns', async () => {
    const { backend, calls } = recordingBackend();
    const summarizer = recordingSummarizer();
    const session = new ChatSession({
      backend,
      generateFn: summarizer.gen,
      compactAtTokens: 0, // any non-empty transcript triggers compaction
      keepRecentTurns: 1,
    });
    await session.send('first'); // no compaction (transcript empty at entry)
    await session.send('second'); // compaction fires before this turn

    expect(summarizer.calls).toHaveLength(1);
    // The post-compaction reset carries the recap and the one kept recent turn.
    const lastReset = [...calls].reverse().find((c) => c.kind === 'reset');
    expect(lastReset?.system).toContain('Conversation so far:\nSUMMARY');
    expect(lastReset?.seed).toEqual([{ role: 'assistant', content: 'reply:first' }]);
  });

  it('compact() is a no-op when there is nothing older than keepRecentTurns', async () => {
    const { backend } = recordingBackend();
    const summarizer = recordingSummarizer();
    const session = new ChatSession({ backend, generateFn: summarizer.gen, keepRecentTurns: 4, compactAtTokens: 1e9 });
    await session.send('hi');
    await session.compact();
    expect(summarizer.calls).toHaveLength(0);
  });

  // AFM-54 — transition-matrix cases: the threshold is crossed more than once in a
  // single session. Prior tests only ever asserted the *first* compaction; these
  // drive the "compact → keep going → compact again" transition the coverage % hides.

  it('compacts repeatedly across a session, folding the prior recap into each new summary (AFM-54)', async () => {
    const { backend, calls } = recordingBackend();
    const summarizer = recordingSummarizer();
    const session = new ChatSession({
      backend,
      generateFn: summarizer.gen,
      compactAtTokens: 0, // any non-empty transcript triggers compaction
      keepRecentTurns: 1,
    });
    await session.send('a'); // no compaction (transcript empty at entry)
    await session.send('b'); // 1st compaction fires before this turn
    await session.send('c'); // 2nd compaction fires before this turn

    // Two distinct threshold crossings, not one — the repeated transition.
    expect(summarizer.calls).toHaveLength(2);
    // The 2nd compaction must fold the recap the 1st produced (not just raw turns);
    // otherwise repeated compaction silently drops earlier context.
    expect(summarizer.calls[1]?.messages[0]?.content).toContain('Previous summary:\nSUMMARY');
    // The latest reset carries the rolling recap into the effective system prompt.
    const lastReset = [...calls].reverse().find((c) => c.kind === 'reset');
    expect(lastReset?.system).toContain('Conversation so far:\nSUMMARY');
  });

  it('keeps converging when the recap itself stays over the threshold (no wedge) (AFM-54)', async () => {
    const { backend } = recordingBackend();
    // A recap ~100 tokens long: once it exists, the effective system prompt alone
    // stays over the 5-token bound, so shouldCompact() is true on every later turn.
    const bigSummary = 'x'.repeat(400);
    const summarizerCalls: string[][] = [];
    const gen: GenerateFn = (_system, messages) => {
      summarizerCalls.push(messages.map((m) => m.content));
      return Promise.resolve(bigSummary);
    };
    const session = new ChatSession({ backend, generateFn: gen, compactAtTokens: 5, keepRecentTurns: 1 });

    // Every over-threshold send still completes and makes forward progress...
    for (const t of ['one', 'two', 'three', 'four', 'five']) {
      await expect(session.send(t)).resolves.toBe(`reply:${t}`);
    }
    // ...compacting on each crossing rather than looping/wedging on the oversized recap...
    expect(summarizerCalls.length).toBeGreaterThanOrEqual(3);
    // ...and history stays bounded (kept recent turn + the just-added user/assistant pair),
    // proving the transcript does not grow unbounded despite the recap re-overflowing.
    expect(session.history().length).toBeLessThanOrEqual(3);
  });

  it('resets to empty then compacts fresh — no stale recap carried across the reset (AFM-54)', async () => {
    const { backend } = recordingBackend();
    const summarizer = recordingSummarizer();
    const session = new ChatSession({ backend, generateFn: summarizer.gen, compactAtTokens: 0, keepRecentTurns: 1 });
    await session.send('a');
    await session.send('b'); // 1st compaction (summary = SUMMARY)
    expect(summarizer.calls).toHaveLength(1);

    session.reset(); // drain to empty
    expect(session.history()).toEqual([]);

    await session.send('c'); // fresh transcript, no compaction at entry
    await session.send('d'); // compaction on the refilled transcript
    expect(summarizer.calls).toHaveLength(2);
    // The post-reset compaction must NOT fold the pre-reset recap — reset() cleared it.
    expect(summarizer.calls[1]?.messages[0]?.content).not.toContain('Previous summary:');
  });
});

describe('ChatSession.reset / close', () => {
  it('clears history and resets the backend with a new system prompt on the next turn', async () => {
    const { backend, calls } = recordingBackend();
    const session = new ChatSession({ system: 'old', backend, compactAtTokens: 1e9 });
    await session.send('hi');
    session.reset('new');
    expect(session.history()).toEqual([]);
    await session.send('again');
    const lastReset = [...calls].reverse().find((c) => c.kind === 'reset');
    expect(lastReset?.system).toBe('new');
  });

  it('close() tears down the backend', () => {
    const { backend, calls } = recordingBackend();
    new ChatSession({ backend }).close();
    expect(calls).toEqual([{ kind: 'close' }]);
  });
});
