/**
 * The `bash` built-in tool (FR-14 / AF-5 phase 3): run a shell command and return
 * its stdout, stderr, and exit code to the model.
 *
 * High-risk, so it is gated by the phase-2 permission policy (its `permissionKey` is
 * the command, so a user can `--allow-tool "bash:git "` to pre-approve a prefix). The
 * command is passed as a single argv element to `sh -c` (never concatenated into
 * another shell string), the run is timeout-bounded, and the captured output is
 * capped so a runaway command can't blow the model's context window.
 */
import { spawn } from 'node:child_process';

import { capOutput } from '../output.js';
import type { Tool } from '../types.js';

/** Kill a command that runs longer than this (ms). */
const DEFAULT_TIMEOUT_MS = 30_000;

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
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve(report({ stdout, stderr, status: `failed to start: ${error.message}` }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const status = timedOut
        ? `timed out after ${String(timeoutMs)}ms (killed)`
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
  permissionKey: (args) => (typeof args.command === 'string' ? args.command : undefined),
  describe: (args) => `run: ${typeof args.command === 'string' ? args.command : '(no command)'}`,
  usageHint: 'bash — run a shell command; use it to inspect the system or run CLI tools, NOT to read files or fetch URLs.',
  run: (args) => runShellCommand(typeof args.command === 'string' ? args.command : ''),
};
