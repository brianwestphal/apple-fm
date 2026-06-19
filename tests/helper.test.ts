import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { generate, HELPER_BIN_ENV, probe, resolveHelperPath } from '../src/helper.js';

const STUB = fileURLToPath(new URL('./fixtures/stub-helper.js', import.meta.url));

beforeAll(() => {
  chmodSync(STUB, 0o755);
});

afterEach(() => {
  Reflect.deleteProperty(process.env, HELPER_BIN_ENV);
  delete process.env.STUB_UNAVAILABLE;
  delete process.env.STUB_HANG;
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
