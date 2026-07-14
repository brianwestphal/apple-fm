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

/** Options for {@link runShellCommand} (exposed so tests can shorten the timeout). */
export interface ShellOptions {
  timeoutMs?: number;
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
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let settled = false;

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

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: string) => (stderr = append(stderr, chunk)));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(report({ stdout, stderr, status: `failed to start: ${error.message}` }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = timedOut
        ? `timed out after ${String(timeoutMs)}ms (killed)`
        : overflowed
          ? `killed after exceeding the ${String(MAX_CAPTURE_CHARS)}-byte output limit`
          : code !== null
            ? `exit code: ${String(code)}`
            : `killed by signal ${String(signal)}`;
      resolve(report({ stdout, stderr, status }));
    });
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
