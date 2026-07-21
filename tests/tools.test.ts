/**
 * Unit tests for the tool-calling Node layer (FR-14 / AF-5 phase 1): the
 * {@link ToolRegistry}, the built-in `read` tool, and `registryFromNames`. The
 * round-trip through a live session (dispatcher + protocol) is covered in
 * `liveSession.test.ts`; here we test the pieces in isolation.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readTextFile, withTimeout } from '../src/tools/builtin/read.js';
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
    const prompt = toolGuidancePrompt(registryFromNames(['read', 'bash']));
    expect(prompt).toMatch(/never claim you cannot/i);
    expect(prompt).toContain('- read —');
    expect(prompt).toContain('- bash —');
  });

  it('tells the model to call one tool per job (AFM-41)', () => {
    const prompt = toolGuidancePrompt(registryFromNames(['read', 'bash']));
    expect(prompt).toMatch(/ONE tool/i);
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

  it('exposes read and bash as built-ins', () => {
    expect(BUILTIN_TOOLS.read).toBe(readTool);
    expect(registryFromNames(['read', 'bash']).names().sort()).toEqual(['bash', 'read']);
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

  it('returns a clear message for a URL path instead of a confusing fs error (AFM-41)', async () => {
    const out = await readTool.run({ path: 'https://example.com/article' }, {});
    expect(out).toMatch(/is a URL/);
    expect(out).toMatch(/only reads local files/i);
    expect(out).not.toMatch(/ENOENT/); // not framed as a failure the model misreads
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

  it('matchKey treats a grant as a resolved path boundary (AFM-63)', () => {
    // Exact file + descendants of a directory match…
    expect(readTool.matchKey?.('/proj', '/proj', 'allow')).toBe(true);
    expect(readTool.matchKey?.('/proj', '/proj/src/a.ts', 'allow')).toBe(true);
    // …but a `..` escape and a name-prefix sibling do not.
    expect(readTool.matchKey?.('/proj', '/proj/../.ssh/id_rsa', 'allow')).toBe(false);
    expect(readTool.matchKey?.('/proj', '/proj-secrets/x', 'allow')).toBe(false);
    expect(readTool.dangerous).toBeUndefined(); // read is not high-risk
  });

  it('matchKey enforces the boundary against the REAL path — a symlink inside an approved dir cannot escape (AFM-76)', () => {
    const approved = mkdtempSync(join(tmpdir(), 'afm-approved-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'afm-outside-'));
    try {
      const secret = join(outsideDir, 'secret.txt');
      writeFileSync(secret, 'AWS_SECRET=leaked', 'utf8');
      // A symlink textually inside the grant but pointing outside it.
      const link = join(approved, 'notes.txt');
      symlinkSync(secret, link);
      // Previously matchKey used only resolve() (textual) and returned true → escape.
      // Now it resolves the real path and rejects the boundary escape.
      expect(readTool.matchKey?.(approved, link, 'allow')).toBe(false);
      expect(readTool.matchKey?.(approved, link, 'deny')).toBe(false);
      // …and read() (which follows the symlink) is therefore never authorized for it,
      // while a genuine file inside the approved dir still matches — even though tmpdir
      // may contain symlinked components (macOS /var → /private/var).
      const real = join(approved, 'real.txt');
      writeFileSync(real, 'ok', 'utf8');
      expect(readTool.matchKey?.(approved, real, 'allow')).toBe(true);
    } finally {
      rmSync(approved, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('refuses a named pipe (fifo) instead of hanging forever (AFM-77)', async () => {
    const fifo = join(dir, 'afm-fifo');
    execFileSync('mkfifo', [fifo]);
    try {
      // With no writer this used to block indefinitely; now `stat` rejects it promptly.
      await expect(readTool.run({ path: fifo }, {})).rejects.toThrow(/named pipe|not a regular file/i);
    } finally {
      rmSync(fifo, { force: true });
    }
  }, 3000);

  it('refuses a character device (/dev/null) rather than reading it unbounded (AFM-77)', async () => {
    await expect(readTool.run({ path: '/dev/null' }, {})).rejects.toThrow(/character device|not a regular file/i);
  });

  it('bounds the bytes pulled from disk so a huge file cannot OOM (AFM-77)', async () => {
    const bounded = join(dir, 'bounded.txt');
    writeFileSync(bounded, 'x'.repeat(5000), 'utf8');
    // Only the first maxBytes are read — not all 5000 — so memory stays bounded
    // regardless of file size.
    await expect(readTextFile(bounded, {}, { maxBytes: 100 })).resolves.toBe('x'.repeat(100));
  });

  it('withTimeout rejects a read that never settles (AFM-77 backstop)', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withTimeout(never, 20, '/blocked')).rejects.toThrow(/timed out after 20ms/);
  });

  it('withTimeout normalizes a non-Error rejection and clears its timer', async () => {
    // A rejection before the deadline propagates as an Error (string reason wrapped).
    // The non-Error rejection is the whole point of the test — that's what withTimeout normalizes.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(withTimeout(Promise.reject('nope'), 1000, '/x')).rejects.toThrow(/nope/);
  });
});
