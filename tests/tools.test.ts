/**
 * Unit tests for the tool-calling Node layer (FR-14 / AF-5 phase 1): the
 * {@link ToolRegistry}, the built-in `read` tool, and `registryFromNames`. The
 * round-trip through a live session (dispatcher + protocol) is covered in
 * `liveSession.test.ts`; here we test the pieces in isolation.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Tool } from '../src/tools/index.js';
import { BUILTIN_TOOLS, readTool, registryFromNames, ToolRegistry } from '../src/tools/index.js';

describe('ToolRegistry', () => {
  const fake: Tool = {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    run: (args) => Promise.resolve(`echo:${String(args.text)}`),
  };

  it('registers tools and reports membership + size', () => {
    const reg = new ToolRegistry([fake]);
    expect(reg.size).toBe(1);
    expect(reg.has('echo')).toBe(true);
    expect(reg.has('nope')).toBe(false);
  });

  it('emits model-facing definitions (name/description/parameters only)', () => {
    const reg = new ToolRegistry([fake]);
    expect(reg.definitions()).toEqual([
      { name: 'echo', description: 'echo back', parameters: fake.parameters },
    ]);
  });

  it('runs a registered tool by name', async () => {
    const reg = new ToolRegistry([fake]);
    await expect(reg.run('echo', { text: 'hi' })).resolves.toBe('echo:hi');
  });

  it('throws a clear error for an unknown tool', async () => {
    const reg = new ToolRegistry();
    await expect(reg.run('ghost', {})).rejects.toThrow(/unknown tool: ghost/);
  });

  it('register replaces a tool with the same name', () => {
    const reg = new ToolRegistry([fake]);
    reg.register({ ...fake, description: 'updated' });
    expect(reg.size).toBe(1);
    expect(reg.definitions()[0]?.description).toBe('updated');
  });
});

describe('registryFromNames', () => {
  it('builds a registry from built-in names', () => {
    const reg = registryFromNames(['read']);
    expect(reg.has('read')).toBe(true);
    expect(reg.size).toBe(1);
  });

  it('throws on an unknown built-in name', () => {
    expect(() => registryFromNames(['read', 'bogus'])).toThrow(/unknown built-in tool "bogus"/);
  });

  it('exposes read as a built-in', () => {
    expect(BUILTIN_TOOLS.read).toBe(readTool);
  });
});

describe('read tool', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'afm-read-'));
    file = join(dir, 'sample.txt');
    writeFileSync(file, 'line0\nline1\nline2\nline3\nline4\n', 'utf8');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the whole file when no range is given', async () => {
    await expect(readTool.run({ path: file }, {})).resolves.toBe('line0\nline1\nline2\nline3\nline4\n');
  });

  it('honors a line offset + limit', async () => {
    await expect(readTool.run({ path: file, offset: 1, limit: 2 }, {})).resolves.toBe('line1\nline2');
  });

  it('treats offset alone as "from here to end"', async () => {
    await expect(readTool.run({ path: file, offset: 3 }, {})).resolves.toBe('line3\nline4\n');
  });

  it('ignores a negative / non-integer range (reads the whole file)', async () => {
    await expect(readTool.run({ path: file, offset: -1, limit: 1.5 }, {})).resolves.toContain('line0');
  });

  it('rejects a missing path', async () => {
    await expect(readTool.run({}, {})).rejects.toThrow(/"path" \(string\) is required/);
  });

  it('rejects a non-existent file (the fs error propagates)', async () => {
    await expect(readTool.run({ path: join(dir, 'nope.txt') }, {})).rejects.toThrow();
  });
});
