import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { LiveSession } from '../src/liveSession.js';
import type { AskOutcome, Tool } from '../src/tools/index.js';
import { PermissionPolicy, ToolRegistry } from '../src/tools/index.js';

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
  it('counts with the active helper only when reset advertises a native token budget', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      expect(await session.tokenBudget('abc')).toBeUndefined();
      await session.reset('');
      expect(await session.tokenBudget('abc')).toBeUndefined();
      session.close();
      vi.stubEnv('STUB_TOKEN_BUDGET', '1');
      await session.reset('');
      expect(await session.tokenBudget('abc')).toEqual({ tokens: 103, contextSize: 4096 });
    } finally {
      session.close();
      vi.unstubAllEnvs();
    }
  });


  it('reports an unavailable model before a command ID is available', async () => {
    vi.stubEnv('STUB_UNAVAILABLE', '1');
    const session = new LiveSession({ binPath: STUB, model: 'on-device' });
    try {
      await expect(session.reset('')).rejects.toThrow(/\[unavailable\].*Apple Foundation Models/);
    } finally {
      session.close();
      vi.unstubAllEnvs();
    }
  });

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

  it('interrupts an in-flight turn and resolves with the partial reply (FR-15)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      const controller = new AbortController();
      const chunks: string[] = [];
      // STREAM_FOREVER streams one delta then waits for a cancel.
      const pending = session.send('STREAM_FOREVER', (c) => chunks.push(c), controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the first delta land
      expect(chunks).toEqual(['partial ']);
      controller.abort();
      await expect(pending).resolves.toBe('partial '); // partial kept, no error
      // The session is still usable after an interrupt.
      const result = parseResult(await session.send('ok'));
      expect(result.turns).toBe(2); // the interrupted turn counted, then a normal turn
    } finally {
      session.close();
    }
  });

  it('cancelling an already-settled turn is a harmless no-op', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const reply = await session.send('go', undefined, controller.signal); // completes immediately
      expect(reply).toBe(JSON.stringify({ instructions: '', turns: 1, prompt: 'go' }));
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      controller.abort(); // after settle — must not throw or wedge the session
      const next = parseResult(await session.send('again'));
      expect(next.turns).toBe(2);
    } finally {
      session.close();
    }
  });

  it('skips a pre-aborted turn without writing to the session (AFM-61RARJ)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('sys');
      const onDelta = vi.fn();
      await expect(session.send('skip', onDelta, AbortSignal.abort())).resolves.toBe('');
      expect(onDelta).not.toHaveBeenCalled();
      expect(parseResult(await session.send('next'))).toMatchObject({ instructions: 'sys', turns: 1 });
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

  // AFM-53 — adversarial transition-matrix cases. Prior tests drive one command at a
  // time from a settled state, so `pending.size` is never >1 and the dead→respawn
  // side-path is only ever taken once. These exercise the transitions the coverage %
  // hides: interleaved in-flight turns, a *second* crash/respawn, and close-while-busy.

  it('demultiplexes two concurrent in-flight turns to the right awaiters (AFM-53)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('');
      const controller = new AbortController();
      // Turn A (id "1") stays open — STREAM_FOREVER waits for a cancel — so it is
      // still pending when turn B is dispatched: `pending` holds two entries at once.
      const a = session.send('STREAM_FOREVER', undefined, controller.signal);
      // Turn B (id "2") completes immediately, so its result returns *before* A's
      // (out of order). It must route to B's awaiter, not the still-open A.
      const b = parseResult(await session.send('hello'));
      expect(b.prompt).toBe('hello');
      // Now settle A; its partial must route back to A's awaiter, not B's.
      controller.abort();
      await expect(a).resolves.toBe('partial ');
      // The session is still healthy for a subsequent turn.
      expect(parseResult(await session.send('after')).prompt).toBe('after');
    } finally {
      session.close();
    }
  });

  it('respawns again after a second crash (repeated dead → respawn) (AFM-53)', async () => {
    const session = new LiveSession({ binPath: STUB });
    try {
      await session.reset('sys');
      await expect(session.send('CRASH')).rejects.toThrow(/\[sessionClosed\]/); // crash #1
      await session.reset('sys'); // respawn #1
      expect(parseResult(await session.send('ok')).turns).toBe(1);
      await expect(session.send('CRASH')).rejects.toThrow(/\[sessionClosed\]/); // crash #2
      await session.reset('sys'); // respawn #2 — the repeated transition
      expect(parseResult(await session.send('ok2')).turns).toBe(1);
    } finally {
      session.close();
    }
  });

  it('close() while a turn is in flight rejects the pending send (AFM-53)', async () => {
    const session = new LiveSession({ binPath: STUB });
    await session.reset('');
    // STREAM_FOREVER never settles on its own, so the send is still pending when we
    // close — exercising rejectAll via the explicit close() call (not process exit).
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = session.send('STREAM_FOREVER', undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let it register as in-flight
    session.close();
    await expect(pending).rejects.toThrow(/\[sessionClosed\] live session closed/);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
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

  it('kills a stalled child and rejects its other pending commands (AFM-KP3NY0)', async () => {
    const session = new LiveSession({ binPath: STUB, timeoutMs: 400 });
    try {
      await session.reset('old');
      const pid = Number(await session.send('PID'));
      let sawDelta: () => void = () => undefined;
      const started = new Promise<void>((resolve) => { sawDelta = resolve; });
      const first = expect(session.send('STREAM_FOREVER', sawDelta)).rejects.toThrow(/timed out/);
      await started;
      const second = expect(session.send('STREAM_FOREVER')).rejects.toThrow(/sessionClosed/);
      await Promise.all([first, second]);
      await vi.waitFor(() => { expect(() => { process.kill(pid, 0); }).toThrow(/ESRCH/); });
      await session.reset('new');
      expect(parseResult(await session.send('ok'))).toMatchObject({ instructions: 'new', turns: 1 });
    } finally {
      session.close();
    }
  });

  describe('tool calling (FR-14)', () => {
    it.each(['close', 'timeout'] as const)('drops a tool reply that outlives a child after %s (AFM-KP3NY0)', async (end) => {
      const { tool } = spyTool();
      const calls: Array<(content: string) => void> = [];
      const session = new LiveSession({
        binPath: STUB,
        timeoutMs: 400,
        tools: new ToolRegistry([{ ...tool, run: () => new Promise<string>((resolve) => { calls.push(resolve); }) }]),
        permission: new PermissionPolicy({ default: 'allow' }),
      });
      try {
        await session.reset('old');
        const first = expect(session.send('TOOL fake {}')).rejects.toThrow(end === 'close' ? /sessionClosed/ : /timed out/);
        await vi.waitFor(() => { expect(calls).toHaveLength(1); });
        if (end === 'close') session.close();
        await first;
        await session.reset('new');
        const second = expect(session.send('TOOL fake {}')).resolves.toBe('new result');
        await vi.waitFor(() => { expect(calls).toHaveLength(2); });
        calls[0]?.('stale result');
        await new Promise<void>((resolve) => { setImmediate(resolve); });
        calls[1]?.('new result');
        await second;
      } finally {
        session.close();
      }
    });

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

    it('keeps tool implementations and definitions stable across resets and approvals (AFM-17X7T9)', async () => {
      const { tool, calls } = spyTool();
      const registry = new ToolRegistry([tool]);
      const replacement = vi.fn(() => Promise.resolve('replacement'));
      const session = new LiveSession({
        binPath: STUB,
        tools: registry,
        permission: new PermissionPolicy({ asker: () => {
          registry.register({ ...tool, run: replacement });
          return Promise.resolve('once');
        } }),
      });
      try {
        await session.reset('');
        registry.register({ ...tool, name: 'late' });
        tool.run = replacement;
        await expect(session.send('TOOL fake {"path":"original"}')).resolves.toBe('tool-saw:original');
        await session.reset('again');
        await expect(session.send('TOOL late {}')).rejects.toThrow(/not offered/);
        await expect(session.send('TOOL fake {"path":"next"}')).resolves.toBe('tool-saw:next');
        expect(calls).toEqual([{ path: 'original' }, { path: 'next' }]);
        expect(replacement).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    });

    it('round-trips a model tool call: dispatch → run → feed the result back', async () => {
      const { tool, calls } = spyTool();
      // An explicit allow policy — the default with no policy is now fail-closed (AFM-78).
      const session = new LiveSession({
        binPath: STUB,
        tools: new ToolRegistry([tool]),
        permission: new PermissionPolicy({ default: 'allow' }),
      });
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

    it('feeds a tool failure back to the model as a result (turn does not abort)', async () => {
      const tool: Tool = {
        name: 'fake',
        description: 'always throws',
        parameters: { type: 'object', properties: {} },
        run: () => Promise.reject(new Error('disk on fire')),
      };
      const session = new LiveSession({
        binPath: STUB,
        tools: new ToolRegistry([tool]),
        permission: new PermissionPolicy({ default: 'allow' }),
      });
      try {
        await session.reset('sys');
        // A thrown tool error aborts the whole turn on-device, so the dispatcher
        // feeds failures back as the tool result instead.
        await expect(session.send('TOOL fake {}')).resolves.toMatch(/The "fake" tool failed: disk on fire/);
      } finally {
        session.close();
      }
    });

    it('keeps the session alive after a tool round-trip', async () => {
      const { tool } = spyTool();
      const session = new LiveSession({
        binPath: STUB,
        tools: new ToolRegistry([tool]),
        permission: new PermissionPolicy({ default: 'allow' }),
      });
      try {
        await session.reset('sys');
        await session.send('TOOL fake {"path":"a"}');
        const after = parseResult(await session.send('ok'));
        expect(after.turns).toBe(2); // the tool turn counted, then a normal turn
      } finally {
        session.close();
      }
    });

    it('is fail-closed: tools registered but NO permission policy ⇒ the tool never runs (AFM-78)', async () => {
      const { tool, calls } = spyTool();
      // No `permission` supplied — previously this ran the tool ungated. It must now
      // default to a fail-closed policy so a tool_call (incl. one from a compromised
      // helper) is denied rather than executed.
      const session = new LiveSession({ binPath: STUB, tools: new ToolRegistry([tool]) });
      try {
        await session.reset('sys');
        await expect(session.send('TOOL fake {"path":"x"}')).resolves.toMatch(/denied by the user/);
        expect(calls).toEqual([]); // the tool was never invoked
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

    describe('permission gate (phase 2)', () => {
      function withPolicy(policy: PermissionPolicy): { session: LiveSession; calls: Array<Record<string, unknown>> } {
        const { tool, calls } = spyTool();
        const session = new LiveSession({ binPath: STUB, tools: new ToolRegistry([tool]), permission: policy });
        return { session, calls };
      }

      it('runs the tool when the policy allows it', async () => {
        const { session } = withPolicy(new PermissionPolicy({ allow: ['fake'] }));
        try {
          await session.reset('sys');
          await expect(session.send('TOOL fake {"path":"x"}')).resolves.toBe('tool-saw:x');
        } finally {
          session.close();
        }
      });

      it('refuses a denied call and tells the model (tool never runs)', async () => {
        const { session, calls } = withPolicy(new PermissionPolicy({ deny: ['fake'] }));
        try {
          await session.reset('sys');
          // The refusal is fed back as the tool result so the model can continue.
          await expect(session.send('TOOL fake {"path":"x"}')).resolves.toMatch(/denied by the user/);
          expect(calls).toEqual([]); // tool never ran
        } finally {
          session.close();
        }
      });

      it('denies an ask with no asker (non-interactive default)', async () => {
        const { session } = withPolicy(new PermissionPolicy()); // default ask, no asker
        try {
          await session.reset('sys');
          await expect(session.send('TOOL fake {}')).resolves.toMatch(/denied by the user/);
        } finally {
          session.close();
        }
      });

      it('prompts and runs when the asker approves', async () => {
        const { session } = withPolicy(new PermissionPolicy({ asker: () => Promise.resolve<AskOutcome>('once') }));
        try {
          await session.reset('sys');
          await expect(session.send('TOOL fake {"path":"y"}')).resolves.toBe('tool-saw:y');
        } finally {
          session.close();
        }
      });
    });
  });
});
