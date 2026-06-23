import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { LiveSession } from '../src/liveSession.js';
import type { Tool } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/index.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-helper.js', import.meta.url));

beforeAll(() => {
  chmodSync(STUB, 0o755);
});

/** The stub's normal turn result is JSON describing the session state. */
function parseResult(content: string): { instructions: string; turns: number; prompt: string } {
  const value: unknown = JSON.parse(content);
  return value as { instructions: string; turns: number; prompt: string };
}

describe('LiveSession', () => {
  it('keeps context across turns in one session (KV-cache reuse)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('sys');
      const first = parseResult(await session.send('a'));
      const second = parseResult(await session.send('b'));
      expect(first.turns).toBe(1);
      expect(second.turns).toBe(2); // same session — the turn count accumulates
      expect(second.instructions).toBe('sys');
      expect(second.prompt).toBe('b');
    } finally {
      session.close();
    }
  });

  it('reset recreates the session (turns reset; seed folded into instructions)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('sys');
      await session.send('a');
      await session.reset('sys2', [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: 'y' },
      ]);
      const result = parseResult(await session.send('b'));
      expect(result.turns).toBe(1); // counter reset
      expect(result.instructions).toBe('sys2 [seed:2]');
    } finally {
      session.close();
    }
  });

  it('streams deltas and returns the assembled text', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      const chunks: string[] = [];
      const full = await session.send('go', (c) => chunks.push(c));
      expect(chunks).toEqual(['Hello ', 'world']);
      expect(full).toBe('Hello world');
    } finally {
      session.close();
    }
  });

  it('surfaces a per-turn error without ending the session', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      await expect(session.send('BOOM')).rejects.toThrow(/\[inferenceFailed\]/);
      const result = parseResult(await session.send('ok')); // session still alive
      expect(result.turns).toBe(1);
    } finally {
      session.close();
    }
  });

  it('surfaces contextWindowExceeded per-turn', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      await expect(session.send('OVERFLOW')).rejects.toThrow(/\[contextWindowExceeded\]/);
    } finally {
      session.close();
    }
  });

  it('respawns the helper after it crashes', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('sys');
      await expect(session.send('CRASH')).rejects.toThrow(/\[sessionClosed\]/);
      // The next command respawns the helper; reset re-establishes context.
      await session.reset('sys');
      const result = parseResult(await session.send('ok'));
      expect(result.turns).toBe(1);
    } finally {
      session.close();
    }
  });

  it('ignores malformed / non-object / mis-id-ed / unknown-type lines and still resolves', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      const content = await session.send('JUNK'); // stub emits junk lines then a real result
      expect(JSON.parse(content)).toEqual({ ok: true });
    } finally {
      session.close();
    }
  });

  it('times out a hung turn', async () => {
    const session = new LiveSession({ binPath: STUB, timeoutMs: 150 });
    try {
      // STUB_HANG makes the stub never respond.
      process.env.STUB_HANG = '1';
      await expect(session.send('x')).rejects.toThrow(/timed out/);
    } finally {
      delete process.env.STUB_HANG;
      session.close();
    }
  });

  describe('tool calling (FR-14)', () => {
    /** A tool that records its calls and echoes the args back as its result. */
    function spyTool(): { tool: Tool; calls: Array<Record<string, unknown>> } {
      const calls: Array<Record<string, unknown>> = [];
      const tool: Tool = {
        name: 'fake',
        description: 'records and echoes',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        run: (args) => {
          calls.push(args);
          return Promise.resolve(`tool-saw:${String(args.path)}`);
        },
      };
      return { tool, calls };
    }

    it('round-trips a model tool call: dispatch → run → feed the result back', async () => {
      const { tool, calls } = spyTool();
      const session = new LiveSession({ binPath: STUB, tools: new ToolRegistry([tool]) });
      try {
        await session.reset('sys'); // tools bind at reset
        // The stub's `TOOL <name> <jsonArgs>` sentinel emits a tool_call, then
        // resolves the turn with whatever tool_result Node writes back.
        const reply = await session.send('TOOL fake {"path":"x.txt"}');
        expect(reply).toBe('tool-saw:x.txt');
        expect(calls).toEqual([{ path: 'x.txt' }]); // args round-tripped from the model
      } finally {
        session.close();
      }
    });

    it('surfaces a tool failure to the model as a tool_error → turn error', async () => {
      const tool: Tool = {
        name: 'fake',
        description: 'always throws',
        parameters: { type: 'object', properties: {} },
        run: () => Promise.reject(new Error('disk on fire')),
      };
      const session = new LiveSession({ binPath: STUB, tools: new ToolRegistry([tool]) });
      try {
        await session.reset('sys');
        await expect(session.send('TOOL fake {}')).rejects.toThrow(/\[toolFailed\] disk on fire/);
      } finally {
        session.close();
      }
    });

    it('keeps the session alive after a tool round-trip', async () => {
      const { tool } = spyTool();
      const session = new LiveSession({ binPath: STUB, tools: new ToolRegistry([tool]) });
      try {
        await session.reset('sys');
        await session.send('TOOL fake {"path":"a"}');
        const after = parseResult(await session.send('ok'));
        expect(after.turns).toBe(2); // the tool turn counted, then a normal turn
      } finally {
        session.close();
      }
    });

    it('does not offer tools the model was not given (empty registry ⇒ no tools[])', async () => {
      const session = new LiveSession({ binPath: STUB }); // no tools
      try {
        await session.reset('sys');
        await expect(session.send('TOOL fake {}')).rejects.toThrow(/not offered/);
      } finally {
        session.close();
      }
    });
  });
});
