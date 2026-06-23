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
import { BUILTIN_TOOLS, readTool, registryFromNames, toolGuidancePrompt, ToolRegistry } from '../src/tools/index.js';

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

  it('lists tool names', () => {
    expect(new ToolRegistry([fake]).names()).toEqual(['echo']);
  });

  it('builds a permission request (falls back to a generic description without hooks)', () => {
    const reg = new ToolRegistry([fake]);
    expect(reg.permissionRequest('echo', { text: 'hi' })).toEqual({
      tool: 'echo',
      key: undefined,
      description: 'echo {"text":"hi"}',
      args: { text: 'hi' },
    });
    expect(reg.permissionRequest('ghost', {})).toBeUndefined();
  });

  it('uses a tool’s permissionKey / describe hooks when present', () => {
    const reg = new ToolRegistry([readTool]);
    const request = reg.permissionRequest('read', { path: '/etc/hosts' });
    expect(request).toMatchObject({ tool: 'read', key: '/etc/hosts', description: 'read /etc/hosts' });
  });

  it('usageHints uses a tool’s usageHint, falling back to name: description', () => {
    const hinted: Tool = { ...fake, usageHint: 'echo — echoes text back.' };
    expect(new ToolRegistry([hinted]).usageHints()).toEqual(['echo — echoes text back.']);
    expect(new ToolRegistry([fake]).usageHints()).toEqual(['echo: echo back']); // fallback
  });
});

describe('toolGuidancePrompt', () => {
  it('is empty for a registry with no tools', () => {
    expect(toolGuidancePrompt(new ToolRegistry())).toBe('');
  });

  it('lists each enabled tool and tells the model not to refuse', () => {
    const prompt = toolGuidancePrompt(registryFromNames(['read', 'bash', 'web']));
    expect(prompt).toMatch(/never claim you cannot/i);
    expect(prompt).toContain('- read —');
    expect(prompt).toContain('- bash —');
    expect(prompt).toContain('- web —');
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

  it('exposes read, bash, and web as built-ins', () => {
    expect(BUILTIN_TOOLS.read).toBe(readTool);
    expect(registryFromNames(['read', 'bash', 'web']).names().sort()).toEqual(['bash', 'read', 'web']);
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

  it('caps a large file so it cannot overflow the model context (AFM-38)', async () => {
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'y'.repeat(40_000), 'utf8');
    const out = await readTool.run({ path: big }, {});
    expect(out).toMatch(/more chars truncated/);
    expect(out.length).toBeLessThan(8_000);
  });

  it('exposes a path-scoped permission key + description (and tolerates a missing path)', () => {
    expect(readTool.permissionKey?.({ path: '/a/b' })).toBe('/a/b');
    expect(readTool.permissionKey?.({})).toBeUndefined();
    expect(readTool.describe?.({ path: '/a/b' })).toBe('read /a/b');
    expect(readTool.describe?.({})).toBe('read (no path)');
  });
});
