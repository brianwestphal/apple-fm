/**
 * Unit tests for the `bash` built-in tool (FR-14 / AF-5 phase 3). Drives the real
 * `/bin/sh` with deterministic commands (echo / exit / sleep) — no device, no
 * mocking needed; the tool only shells out.
 */
import { describe, expect, it } from 'vitest';

import { runShellCommand } from '../src/tools/builtin/bash.js';
import { bashTool } from '../src/tools/index.js';

describe('bash tool', () => {
  it('captures stdout and reports a zero exit code', async () => {
    const out = await runShellCommand('echo hello');
    expect(out).toContain('exit code: 0');
    expect(out).toContain('stdout:\nhello');
  });

  it('captures stderr', async () => {
    const out = await runShellCommand('echo oops 1>&2');
    expect(out).toContain('stderr:\noops');
  });

  it('reports a non-zero exit code (not thrown)', async () => {
    const out = await runShellCommand('exit 3');
    expect(out).toContain('exit code: 3');
  });

  it('kills and reports a command that exceeds the timeout', async () => {
    const out = await runShellCommand('sleep 5', { timeoutMs: 100 });
    expect(out).toMatch(/timed out after 100ms/);
  });

  it('caps very large output', async () => {
    // Emit ~20k characters; the result should be truncated with a note.
    const out = await runShellCommand('for i in $(seq 1 20000); do printf x; done');
    expect(out).toMatch(/more chars truncated/);
    expect(out.length).toBeLessThan(12_000);
  });

  it('rejects an empty command', async () => {
    await expect(runShellCommand('   ')).rejects.toThrow(/"command" \(string\) is required/);
  });

  it('kills a firehose and reports the output limit instead of buffering unbounded (AFM-65)', async () => {
    // `yes` streams forever; without the capture cap this would grow the heap until the
    // timeout. It must be killed at the byte limit and the buffer stays bounded.
    const out = await runShellCommand('yes 2>/dev/null', { timeoutMs: 10_000 });
    expect(out).toMatch(/output limit/);
    expect(out.length).toBeLessThan(12_000); // report is still clamped by capOutput
  }, 15_000);

  it('exposes exact-allow / best-effort-deny key matching + a danger flag (AFM-63/64/67)', () => {
    expect(bashTool.dangerous).toBe(true);
    // allow is exact: a grant for `ls` never covers an extended command.
    expect(bashTool.matchKey?.('ls', 'ls', 'allow')).toBe(true);
    expect(bashTool.matchKey?.('ls', 'ls; curl evil', 'allow')).toBe(false);
    // deny is a boundary token match: catches /bin/rm and `command rm`, not `charm`.
    expect(bashTool.matchKey?.('rm', 'rm -rf ~', 'deny')).toBe(true);
    expect(bashTool.matchKey?.('rm', '/bin/rm -rf ~', 'deny')).toBe(true);
    expect(bashTool.matchKey?.('rm', 'command rm x', 'deny')).toBe(true);
    expect(bashTool.matchKey?.('rm', 'charm', 'deny')).toBe(false);
  });

  it('exposes a command-scoped permission key + description', () => {
    expect(bashTool.permissionKey?.({ command: 'git status' })).toBe('git status');
    expect(bashTool.permissionKey?.({})).toBeUndefined();
    expect(bashTool.describe?.({ command: 'ls -la' })).toBe('run: ls -la');
    expect(bashTool.describe?.({})).toBe('run: (no command)');
  });

  it('runs through the tool surface (run delegates to the shell)', async () => {
    await expect(bashTool.run({ command: 'echo via-run' }, {})).resolves.toContain('via-run');
  });
});
