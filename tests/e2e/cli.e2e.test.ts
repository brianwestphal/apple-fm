/**
 * End-to-end tests for the assembled `apple-fm` CLI (AFM-25).
 *
 * Unlike the unit tests — which call the library functions directly — these spawn
 * the *real* CLI as a child process and assert on its stdout/stderr and exit code,
 * so the full `parseArgs → I/O → helper/session → output` wiring (incl. `cli.ts`
 * and `repl.ts`, which are excluded from in-process coverage) is exercised as a
 * user would hit it.
 *
 * Device-free: the CLI is pointed at `tests/fixtures/stub-helper.js` via
 * `APPLE_FM_BIN`, the same JS reimplementation of the NDJSON protocol the rest of
 * the suite uses, so no macOS 26 / Apple Intelligence device is needed. (The
 * on-device half — running the real Swift helper — remains AF-2.) The CLI source
 * is run through `tsx` so no prior build is required.
 */
import { spawn } from 'node:child_process';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const STUB = fileURLToPath(new URL('../fixtures/stub-helper.js', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../fixtures/cli-schema.json', import.meta.url));
const BAD_SCHEMA = fileURLToPath(new URL('../fixtures/cli-bad-schema.json', import.meta.url));
const READ_SAMPLE = fileURLToPath(new URL('../fixtures/read-sample.txt', import.meta.url));

/** Each case spawns node+tsx; allow generous headroom over the cold-start cost. */
const T = 20_000;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run the real CLI with `args`, the stub as the helper, and resolve its result. */
function runCli(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, APPLE_FM_BIN: STUB, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(opts.input ?? '');
  });
}

beforeAll(() => {
  chmodSync(STUB, 0o755);
});

describe('apple-fm CLI (e2e)', () => {
  describe('probe', () => {
    it(
      'prints availability and exits 0 when the model is ready',
      async () => {
        const { stdout, code } = await runCli(['probe']);
        expect(JSON.parse(stdout.trim())).toEqual({ available: true });
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'prints the reason and exits 1 when unavailable',
      async () => {
        const { stdout, code } = await runCli(['probe'], { env: { STUB_UNAVAILABLE: '1' } });
        expect(JSON.parse(stdout.trim())).toEqual({ available: false, reason: 'appleIntelligenceNotEnabled' });
        expect(code).toBe(1);
      },
      T,
    );
  });

  describe('generate', () => {
    it(
      'prints the result for a prompt argument',
      async () => {
        const { stdout, code } = await runCli(['generate', 'hi there']);
        // The stub echoes the request back as the result JSON.
        expect(JSON.parse(stdout.trim())).toMatchObject({ prompt: 'hi there' });
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'reads the prompt from stdin when no argument is given',
      async () => {
        const { stdout, code } = await runCli(['generate'], { input: 'piped prompt' });
        expect(JSON.parse(stdout.trim())).toMatchObject({ prompt: 'piped prompt' });
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'streams text deltas to stdout',
      async () => {
        const { stdout, code } = await runCli(['generate', 'hi', '--stream']);
        expect(stdout).toContain('Hello world');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'prints JSON conforming to a --schema file',
      async () => {
        const { stdout, code } = await runCli(['generate', 'a task', '--schema', SCHEMA]);
        const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
        expect(Object.keys(value).sort()).toEqual(['rating', 'title']);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'prints the final JSON once when streaming a --schema (piped, non-TTY)',
      async () => {
        const { stdout, code } = await runCli(['generate', 'a task', '--schema', SCHEMA, '--stream']);
        const value = JSON.parse(stdout.trim()) as Record<string, unknown>;
        expect(value).toHaveProperty('title');
        expect(value).toHaveProperty('rating');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'errors with exit 1 when no prompt is given and stdin is empty',
      async () => {
        const { stderr, code } = await runCli(['generate']);
        expect(stderr).toMatch(/no prompt given/);
        expect(code).toBe(1);
      },
      T,
    );

    it(
      'surfaces a friendly [modelNotReady] error and exits 1 while the model provisions',
      async () => {
        const { stderr, code } = await runCli(['generate', 'NOTREADY']);
        expect(stderr).toMatch(/\[modelNotReady\] the on-device model is still provisioning/);
        expect(code).toBe(1);
      },
      T,
    );

    it(
      'surfaces a helper [inferenceFailed] error and exits 1',
      async () => {
        const { stderr, code } = await runCli(['generate', 'BOOM']);
        expect(stderr).toMatch(/\[inferenceFailed\] boom/);
        expect(code).toBe(1);
      },
      T,
    );

    it(
      'rejects a schema the native path cannot express with [unsupportedSchema]',
      async () => {
        const { stderr, code } = await runCli(['generate', 'x', '--schema', BAD_SCHEMA]);
        expect(stderr).toMatch(/\[unsupportedSchema\]/);
        expect(code).toBe(1);
      },
      T,
    );
  });

  describe('global flags', () => {
    it(
      '--help prints usage and exits 0',
      async () => {
        const { stdout, code } = await runCli(['--help']);
        expect(stdout).toMatch(/Usage:/);
        expect(stdout).toContain('apple-fm probe');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      '--version prints the package version and exits 0',
      async () => {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
          version: string;
        };
        const { stdout, code } = await runCli(['--version']);
        expect(stdout.trim()).toBe(pkg.version);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'an unknown command errors and exits 1',
      async () => {
        const { stderr, code } = await runCli(['frobnicate']);
        expect(stderr).toMatch(/unknown command/);
        expect(code).toBe(1);
      },
      T,
    );
  });

  describe('chat (REPL)', () => {
    it(
      'runs a turn, handles slash commands, and exits 0 on EOF',
      async () => {
        const script = ['What is two plus two?', '/help', '/compact', '/clear', '/reset', '/system be terse', '/quit'].join(
          '\n',
        );
        const { stdout, code } = await runCli(['chat'], { input: `${script}\n` });
        expect(stdout).toContain('apple-fm chat'); // welcome banner
        expect(stdout).toContain('Hello world'); // streamed reply to the first turn
        expect(stdout).toContain('Commands:'); // /help
        expect(stdout).toContain('(compacted)'); // /compact
        expect(stdout).toContain('(context cleared)'); // /clear
        expect(stdout).toContain('(reset)'); // /reset
        expect(stdout).toContain('(system updated, conversation reset)'); // /system
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'runs a tool round-trip end-to-end with --tools read',
      async () => {
        // The stub's `TOOL <name> <jsonArgs>` sentinel makes the model "call" read;
        // the CLI's registry actually reads the fixture and feeds it back.
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        // --no-stream so the REPL prints the final reply (the tool turn emits a
        // single `result`, not deltas).
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'read'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toContain('the-eagle-has-landed'); // the file content, via the tool
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'errors and exits 1 for an unknown --tools name',
      async () => {
        const { stderr, code } = await runCli(['chat', '--tools', 'bogus'], { input: '/quit\n' });
        expect(stderr).toMatch(/unknown built-in tool "bogus"/);
        expect(code).toBe(1);
      },
      T,
    );
  });
});
