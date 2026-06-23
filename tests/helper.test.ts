import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { generate, HELPER_BIN_ENV, isPlatformSupported, probe, resolveHelperPath } from '../src/helper.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-helper.js', import.meta.url));

beforeAll(() => {
  chmodSync(STUB, 0o755);
});

afterEach(() => {
  Reflect.deleteProperty(process.env, HELPER_BIN_ENV);
  delete process.env.STUB_UNAVAILABLE;
  delete process.env.STUB_HANG;
});

describe('platform support', () => {
  const realPlatform = process.platform;
  const realArch = process.arch;
  const setPlatform = (platform: string, arch: string): void => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  };
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
  });

  it('isPlatformSupported() is true only on darwin/arm64', () => {
    setPlatform('darwin', 'arm64');
    expect(isPlatformSupported()).toBe(true);
    setPlatform('darwin', 'x64'); // Intel Mac
    expect(isPlatformSupported()).toBe(false);
    setPlatform('linux', 'x64');
    expect(isPlatformSupported()).toBe(false);
    setPlatform('win32', 'x64');
    expect(isPlatformSupported()).toBe(false);
  });

  it('probe reports unsupportedPlatform off-platform without spawning', async () => {
    setPlatform('linux', 'x64');
    expect(await probe()).toEqual({ available: false, reason: 'unsupportedPlatform' });
  });

  it('generate throws a clear [unsupportedPlatform] error off-platform', async () => {
    setPlatform('linux', 'x64');
    await expect(generate({ prompt: 'hi' })).rejects.toThrow(/\[unsupportedPlatform\]/);
  });

  it('an explicit binPath bypasses the platform gate', async () => {
    setPlatform('linux', 'x64'); // pretend we are off-platform…
    // …but a runnable helper (here the stub) is trusted and used anyway.
    expect(await probe({ binPath: STUB })).toEqual({ available: true });
  });
});

describe('resolveHelperPath', () => {
  it('prefers an explicit binPath, then the env var, then the bundled binary', () => {
    expect(resolveHelperPath({ binPath: '/x/y' })).toBe('/x/y');
    process.env[HELPER_BIN_ENV] = '/from/env';
    expect(resolveHelperPath()).toBe('/from/env');
    Reflect.deleteProperty(process.env, HELPER_BIN_ENV);
    expect(resolveHelperPath()).toMatch(/bin\/apple-fm-helper$/);
  });
});

describe('probe', () => {
  it('reports availability', async () => {
    expect(await probe({ binPath: STUB })).toEqual({ available: true });
  });

  it('reports unavailability with a reason', async () => {
    process.env.STUB_UNAVAILABLE = '1';
    expect(await probe({ binPath: STUB })).toEqual({
      available: false,
      reason: 'appleIntelligenceNotEnabled',
    });
  });

  it('times out a hung helper', async () => {
    process.env.STUB_HANG = '1';
    await expect(probe({ binPath: STUB, timeoutMs: 150 })).rejects.toThrow(/timed out/);
  });

  it('rejects when the binary cannot be run', async () => {
    await expect(probe({ binPath: '/no/such/helper' })).rejects.toThrow(/failed to run/);
  });
});

describe('generate', () => {
  it('passes the request through and returns the result content', async () => {
    const content = await generate(
      { prompt: 'hi', system: 'be terse', options: { temperature: 0.3, maxTokens: 64 } },
      { binPath: STUB },
    );
    expect(JSON.parse(content)).toMatchObject({
      prompt: 'hi',
      system: 'be terse',
      options: { temperature: 0.3, maxTokens: 64 },
    });
  });

  it('streams deltas and returns the assembled text', async () => {
    const chunks: string[] = [];
    const text = await generate({ prompt: 'hi', stream: true }, { binPath: STUB }, (c) => chunks.push(c));
    expect(chunks).toEqual(['Hello ', 'world']);
    expect(text).toBe('Hello world');
  });

  it('surfaces helper error events', async () => {
    await expect(generate({ prompt: 'BOOM' }, { binPath: STUB })).rejects.toThrow(/boom/);
  });

  it('surfaces a friendly modelNotReady error while the model is provisioning', async () => {
    await expect(generate({ prompt: 'NOTREADY' }, { binPath: STUB })).rejects.toThrow(
      /\[modelNotReady\] the on-device model is still provisioning/,
    );
  });

  it('passes a messages[] conversation through to the helper (FR-4)', async () => {
    const messages = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
    ];
    const content = await generate({ messages }, { binPath: STUB });
    expect(JSON.parse(content)).toMatchObject({ messages });
  });

  it('surfaces captured stderr when the helper exits nonzero without an error event (NFR-2)', async () => {
    await expect(generate({ prompt: 'STDERR_FAIL' }, { binPath: STUB })).rejects.toThrow(
      /exited with code 2: helper diagnostic: model subsystem offline/,
    );
  });
});

describe('generate with a schema (native guided generation)', () => {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'high'] },
      tags: { type: 'array', items: { type: 'string' } },
      done: { type: 'boolean' },
    },
    required: ['title', 'priority', 'tags', 'done'],
  };

  it('returns JSON shaped to the schema', async () => {
    const content = await generate({ prompt: 'a task', schema }, { binPath: STUB });
    const value = JSON.parse(content) as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual(['done', 'priority', 'tags', 'title']);
    expect(value.priority).toBe('low'); // first enum choice
    expect(Array.isArray(value.tags)).toBe(true);
    expect(typeof value.done).toBe('boolean');
  });

  it('rejects a schema the native path cannot express', async () => {
    await expect(
      generate({ prompt: 'x', schema: { oneOf: [{ type: 'string' }] } }, { binPath: STUB }),
    ).rejects.toThrow(/\[unsupportedSchema\]/);
  });

  it('streams structured output as snapshots and returns the final JSON', async () => {
    const snapshots: string[] = [];
    const content = await generate(
      { prompt: 'a task', schema, stream: true },
      { binPath: STUB },
      undefined, // no text deltas for structured output
      (json) => snapshots.push(json),
    );
    // Snapshots are full partial values (replace, not append); the last equals the result.
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0]).toBe('{}');
    expect(snapshots.at(-1)).toBe(content);
    expect(JSON.parse(content)).toHaveProperty('title');
  });

  it('accepts numeric min/max constraints', async () => {
    const constrained = {
      type: 'object',
      properties: { rating: { type: 'integer', minimum: 1, maximum: 5 } },
      required: ['rating'],
    };
    const content = await generate({ prompt: 'rate it', schema: constrained }, { binPath: STUB });
    expect(JSON.parse(content)).toHaveProperty('rating');
  });

  it('rejects a numeric schema whose minimum exceeds its maximum', async () => {
    const bad = {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 10, maximum: 1 } },
      required: ['n'],
    };
    await expect(generate({ prompt: 'x', schema: bad }, { binPath: STUB })).rejects.toThrow(
      /\[unsupportedSchema\] minimum \(10\) is greater than maximum \(1\)/,
    );
  });
});
