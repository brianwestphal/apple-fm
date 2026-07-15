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

  // AFM-69 — resolve on the shell's `exit`, not `close`. A backgrounded child inherits
  // sh's stdout pipe, so waiting for `close` (pipe EOF) blocked the tool call until that
  // child finished (`sleep 3 & echo done` used to take ~3s). Now the run resolves once
  // sh exits, reaping same-group children so it doesn't dangle.
  it('does not block on a backgrounded pipe-holding child (AFM-69)', async () => {
    const start = Date.now();
    const out = await runShellCommand('sleep 3 & echo done', { timeoutMs: 10_000 });
    const elapsed = Date.now() - start;
    expect(out).toContain('done');
    expect(elapsed).toBeLessThan(1500); // ≪ the backgrounded sleep's 3s lifetime
  });

  it('a pipe-holding child cannot push resolution past the timeout (AFM-69)', async () => {
    // sh exits immediately (echo, sleep backgrounded); even with a short timeout the
    // run resolves promptly instead of waiting for the 5s sleep that holds the pipe.
    const start = Date.now();
    const out = await runShellCommand('sleep 5 & echo done', { timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(out).toContain('done');
    expect(elapsed).toBeLessThan(1500);
  });

  it('a session-detached (setsid) child holding the pipe does not hang the call (AFM-69)', async () => {
    // A perl child that setsid()s escapes sh's process group (so the group-kill misses
    // it) and holds sh's inherited stdout pipe — the exact case that used to hang the
    // tool call forever. The run must still resolve within the grace window.
    const start = Date.now();
    const out = await runShellCommand(
      `perl -e 'use POSIX; POSIX::setsid(); sleep 5' & echo done`,
      { timeoutMs: 10_000 },
    );
    const elapsed = Date.now() - start;
    expect(out).toContain('done');
    expect(elapsed).toBeLessThan(2000); // resolves via exit + grace, not the child's 5s life
  }, 15_000);

  // AFM-70 — the child gets a scoped environment, not the CLI's full process.env, so an
  // approved command can't read secrets the CLI process happens to hold.
  it('does not expose parent secrets to the command by default (AFM-70)', async () => {
    process.env.SECRET_CANARY = 'leaked-value';
    try {
      const out = await runShellCommand('echo "canary=[$SECRET_CANARY]"');
      expect(out).toContain('canary=[]'); // unset in the scoped child
      expect(out).not.toContain('leaked-value');
    } finally {
      delete process.env.SECRET_CANARY;
    }
  });

  it('still passes through the safe allowlist (HOME/PATH) so commands work (AFM-70)', async () => {
    const out = await runShellCommand('echo "home=[$HOME]"; command -v sh >/dev/null && echo path-ok');
    expect(out).toMatch(/home=\[.+\]/); // HOME is allowlisted and non-empty
    expect(out).toContain('path-ok'); // PATH is allowlisted so binaries resolve
  });

  it('inheritEnv opts back into the full parent environment (AFM-70)', async () => {
    process.env.SECRET_CANARY = 'opt-in-value';
    try {
      const out = await runShellCommand('echo "canary=[$SECRET_CANARY]"', { inheritEnv: true });
      expect(out).toContain('canary=[opt-in-value]');
    } finally {
      delete process.env.SECRET_CANARY;
    }
  });
});
