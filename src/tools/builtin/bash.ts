/**
 * The `bash` built-in tool (FR-14 / AF-5 phase 3): run a shell command and return
 * its stdout, stderr, and exit code to the model.
 *
 * High-risk (marked `dangerous`, so a blanket `--yes` never auto-approves it — AFM-64),
 * and gated by the phase-2 permission policy. An **allow** rule must name the command
 * *exactly* (`--allow-tool "bash:git status"` approves only `git status`, not
 * `git status; rm -rf ~`), so one grant can't be extended with shell metacharacters
 * (AFM-63); a **deny** rule is a broad best-effort token match — not a security
 * guarantee (AFM-67). The command is passed as a single argv element to `sh -c` (never
 * concatenated into another shell string), the run is timeout-bounded and killed as a
 * **process group** (so backgrounded children die with it — AFM-65), and the captured
 * output is bounded both while streaming (memory) and on return (the model's context).
 * The child gets a **scoped environment** (a small safe allowlist, not the CLI's full
 * `process.env`) so an approved command can't exfiltrate secrets (AFM-70), and the run
 * resolves on the shell's **`exit`** (not `close`) so a detached grandchild holding the
 * stdio pipes can't hang the tool call past the timeout (AFM-69).
 */
import { spawn } from 'node:child_process';

import { capOutput } from '../output.js';
import type { Tool } from '../types.js';

/** Kill a command that runs longer than this (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on bytes buffered from a command *while it runs*. The returned report
 * is separately clamped by `capOutput`, but that only bounds the final string —
 * without this, a firehose (`cat /dev/zero`, `yes`) fills the Node heap before the
 * timeout fires. Comfortably above the return cap so real output is left intact.
 */
const MAX_CAPTURE_CHARS = 256 * 1024;

/**
 * After the shell itself exits, wait at most this long for our stdout/stderr pipes to
 * reach EOF before resolving with whatever we have. `close` fires only once the pipes
 * drain, and a *detached* (`setsid`) grandchild that inherited them holds them open
 * indefinitely — so `close` alone can hang the tool call forever (AFM-69). We reap the
 * shell's process group on exit (killing same-group `&` children, which closes their
 * copy of the pipe), so `close` normally fires within a tick; this bounds the wait for
 * a grandchild that escaped the group.
 */
const PIPE_DRAIN_GRACE_MS = 100;

/**
 * A minimal, safe set of environment variables passed to the child by default. The
 * child would otherwise inherit `process.env` verbatim, so an approved `bash` command
 * (`env`, `printenv`, `echo $AWS_SECRET_ACCESS_KEY`) would hand the untrusted model
 * every secret in the CLI's environment (AFM-70). This allowlist keeps commands
 * working (a usable `PATH`, `HOME`, locale, temp dir) while excluding the credential
 * vars secrets typically live in. Opt back into full inheritance with
 * `{ inheritEnv: true }` when a command genuinely needs the parent environment.
 */
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
] as const;

/** Build the scoped child environment: the {@link SAFE_ENV_KEYS} that are actually set. */
function scopedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Options for {@link runShellCommand} (exposed so tests can shorten the timeout). */
export interface ShellOptions {
  timeoutMs?: number;
  /**
   * Pass the full parent `process.env` to the command instead of the safe allowlist
   * ({@link SAFE_ENV_KEYS}). Off by default so secrets in the CLI's environment are
   * not exposed to the model (AFM-70). Opt in only when a command needs them.
   */
  inheritEnv?: boolean;
}

/**
 * Run `command` via `sh -c` and resolve a readable report of its exit status,
 * stdout, and stderr. A non-zero exit is a normal result (reported, not thrown) so
 * the model sees the exit code; only an empty command rejects.
 */
export function runShellCommand(command: string, options: ShellOptions = {}): Promise<string> {
  if (command.trim().length === 0) return Promise.reject(new Error('bash: "command" (string) is required'));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    // `detached` makes the child a process-group leader so we can SIGKILL the whole
    // group (negative pid) — a backgrounded child (`sleep 999 &`) can't outlive us.
    // Scope the environment (AFM-70) so an approved command can't read the CLI's secrets.
    const child = spawn('/bin/sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: options.inheritEnv === true ? process.env : scopedEnv(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    // The shell's own exit status, captured on `exit` (fires when the process ends,
    // independent of whether a detached grandchild still holds the stdio pipes).
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL'); // group gone / no permission — fall back to the child
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    // Append a chunk but never let the combined in-memory buffers grow past the
    // capture ceiling; on overflow, keep only what fits and kill the group (AFM-65).
    const append = (buffer: string, chunk: string): string => {
      if (overflowed) return buffer;
      const remaining = MAX_CAPTURE_CHARS - (stdout.length + stderr.length);
      if (chunk.length <= remaining) return buffer + chunk;
      overflowed = true;
      killGroup();
      return buffer + chunk.slice(0, Math.max(0, remaining));
    };

    // Resolve exactly once, with whatever output has been captured. Stop holding the
    // read pipes so a detached grandchild that inherited them can't keep us alive.
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      const status = timedOut
        ? `timed out after ${String(timeoutMs)}ms (killed)`
        : overflowed
          ? `killed after exceeding the ${String(MAX_CAPTURE_CHARS)}-byte output limit`
          : exitCode !== null
            ? `exit code: ${String(exitCode)}`
            : `killed by signal ${String(exitSignal)}`;
      resolve(report({ stdout, stderr, status }));
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: string) => (stderr = append(stderr, chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(report({ stdout, stderr, status: `failed to start: ${error.message}` }));
    });
    // Resolve on the shell's own `exit` (AFM-69), not `close`: `close` waits for the
    // stdio pipes to reach EOF, which a detached grandchild holding them defers
    // forever. On exit, reap the process group (kills same-group `&` children, closing
    // their pipe copy so `close` can fire with the full output), then either resolve at
    // `close` (the normal, fully-drained path) or after a short grace if a grandchild
    // still holds the pipes open. `exit` always fires when the shell ends, so the tool
    // call can no longer hang past it.
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      killGroup();
      // Give the pipes a chance to flush already-buffered output at `close`; if a
      // detached grandchild keeps them open, resolve anyway after the grace window.
      graceTimer = setTimeout(settle, PIPE_DRAIN_GRACE_MS);
    });
    child.on('close', settle);
  });
}

/** Assemble the model-facing report (status line + any stdout/stderr sections). */
function report({ stdout, stderr, status }: { stdout: string; stderr: string; status: string }): string {
  const sections = [status];
  if (stdout.length > 0) sections.push(`stdout:\n${stdout}`);
  if (stderr.length > 0) sections.push(`stderr:\n${stderr}`);
  // Cap the whole report so noisy output can't overflow the on-device context window.
  return capOutput(sections.join('\n'));
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a shell command (via `sh -c`) and return its exit code, stdout, and stderr. ' +
    'Use to inspect the system or run command-line tools. Avoid destructive commands.',
  parameters: {
    type: 'object',
    description: 'Arguments for the bash tool.',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
    },
  },
  dangerous: true,
  permissionKey: (args) => (typeof args.command === 'string' ? args.command : undefined),
  // Allow grants are EXACT — approving `ls` never approves `ls; curl evil` (AFM-63).
  // Deny rules are a broad best-effort token match: the denied token, at a start /
  // whitespace / path boundary, anywhere in the normalized command, so `--deny-tool
  // bash:rm` also catches `/bin/rm` and `command rm` — but this is NOT a security
  // guarantee (`eval`, `$(…)`, aliases evade it); the real control is not enabling
  // bash (AFM-67).
  matchKey: (ruleKey, callKey, kind) => {
    if (kind === 'allow') return ruleKey === callKey;
    const token = ruleKey.trim();
    if (token.length === 0) return false;
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[\\s/])${escaped}`).test(callKey.trim().replace(/\s+/g, ' '));
  },
  describe: (args) => `run: ${typeof args.command === 'string' ? args.command : '(no command)'}`,
  usageHint: 'bash — run a shell command; use it to inspect the system or run CLI tools, NOT to read files or fetch URLs.',
  run: (args) => runShellCommand(typeof args.command === 'string' ? args.command : ''),
};
