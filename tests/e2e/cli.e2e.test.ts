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
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const STUB = fileURLToPath(new URL('../fixtures/stub-helper.js', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../fixtures/cli-schema.json', import.meta.url));
const BAD_SCHEMA = fileURLToPath(new URL('../fixtures/cli-bad-schema.json', import.meta.url));
const READ_SAMPLE = fileURLToPath(new URL('../fixtures/read-sample.txt', import.meta.url));
const INTERACTIVE_STDIN = fileURLToPath(new URL('../fixtures/interactive-stdin.mjs', import.meta.url));

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
    it('lists the on-device model even if an overridden helper reports additional entries', async () => {
      const { stdout, code } = await runCli(['probe'], {
        env: { STUB_LIST_MODELS: '1', STUB_EXTRA_MODEL: '1' },
      });
      expect(JSON.parse(stdout)).toEqual({ available: true, models: [
        { id: 'on-device', available: true },
      ] });
      expect(code).toBe(0);
    }, T);

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

  describe('tokens', () => {
    it.each([
      { args: ['token text'], input: undefined },
      { args: [], input: 'token text\n' },
    ])('prints a token count for $args or stdin', async ({ args, input }) => {
      const { stdout, code } = await runCli(['tokens', ...args], { input });
      expect(stdout).toBe('10\n');
      expect(code).toBe(0);
    }, T);
  });

  it('rejects invalid CLI numbers before invoking the helper', async () => {
    const { stdout, stderr, code } = await runCli(['generate', '--max-tokens', 'Infinity', 'hello']);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('--max-tokens expects a number that is finite');
  }, T);

  describe('chat context usage', () => {
    it('reports native usage before and after a turn and clear', async () => {
      const { stdout, code } = await runCli(['chat', '--no-stream'], {
        env: { STUB_TOKEN_BUDGET: '1' },
        input: '/usage\nfirst\n/usage\n/clear\n/usage\n/quit\n',
      });
      expect(code).toBe(0);
      expect(stdout.match(/Context: \d+ \/ 4096 tokens/g)).toEqual([
        'Context: 100 / 4096 tokens',
        'Context: 110 / 4096 tokens',
        'Context: 100 / 4096 tokens',
      ]);
    }, T);

    it('labels usage as an estimate when the helper has no native counter', async () => {
      const { stdout, code } = await runCli(['chat', '--no-stream'], { input: '/usage\n/quit\n' });
      expect(code).toBe(0);
      expect(stdout).toMatch(/Context: ~\d+ tokens \(estimate\)/);
    }, T);
  });

  describe('chat persistence', () => {
    it('saves privately, resumes in a new process, and refuses to overwrite', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'apple-fm-chat-'));
      try {
        const file = join(directory, 'room.json');
        const first = await runCli(['chat', '--no-stream', '--system', 'sys'], {
          input: `first\n/save ${file}\n/save ${file}\n/quit\n`,
        });
        expect(first.code).toBe(0);
        expect(first.stdout).toContain('(saved)');
        expect(first.stdout).toContain('EEXIST');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        const second = await runCli(['chat', '--no-stream', '--resume', file], {
          env: { STUB_TOKEN_BUDGET: '1' },
          input: '/usage\nsecond\n/quit\n',
        });
        expect(second.stderr).toBe('');
        expect(second.code).toBe(0);
        expect(second.stdout).toContain('Context: 110 / 4096 tokens');
        expect(second.stdout).toContain('"instructions":"sys","turns":2,"prompt":"second"');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, T);

    it('requires the same tools and rejects an invalid native transcript', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'apple-fm-chat-'));
      try {
        const file = join(directory, 'room.json');
        await writeFile(file, JSON.stringify({
          version: 1, system: '', messages: [], tools: ['read'], transcript: 'invalid',
        }));
        const mismatch = await runCli(['chat', '--resume', file]);
        expect(mismatch.stderr).toContain('same --tools list');
        expect(mismatch.code).toBe(1);
        const invalid = await runCli(['chat', '--resume', file, '--tools', 'read']);
        expect(invalid.stderr).toContain('invalid native transcript');
        expect(invalid.code).toBe(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, T);

    it('does not carry forward tool approvals in a resumed chat', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'apple-fm-chat-'));
      try {
        const file = join(directory, 'room.json');
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        const original = await runCli(['chat', '--no-stream', '--tools', 'read', '--yes'], {
          input: `${turn}\n/save ${file}\n/quit\n`,
        });
        expect(original.stdout).toContain('the-eagle-has-landed');
        expect(original.code).toBe(0);
        const resumed = await runCli(['chat', '--no-stream', '--tools', 'read', '--resume', file], {
          input: `${turn}\n/quit\n`,
        });
        expect(resumed.stdout).toContain('denied by the user');
        expect(resumed.stdout).not.toContain('the-eagle-has-landed');
        expect(resumed.code).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, T);

    it('does not send transcript commands to an older helper', async () => {
      const { stdout, code } = await runCli(['chat'], {
        env: { STUB_LEGACY_TRANSCRIPT: '1' },
        input: '/save unused.json\n/quit\n',
      });
      expect(stdout).toContain('native transcript persistence requires a current apple-fm helper');
      expect(code).toBe(0);
    }, T);
  });

  describe('model selection', () => {
    it('accepts explicit on-device generation', async () => {
      const { stdout, code } = await runCli(['generate', 'hello', '--model', 'on-device']);
      expect(JSON.parse(stdout)).toEqual({ prompt: 'hello', options: {}, stream: false });
      expect(code).toBe(0);
    }, T);

    it('accepts explicit on-device chat across a reset', async () => {
      const { stdout, code } = await runCli(['chat', '--model', 'on-device', '--no-stream'], {
        input: 'before\n/clear\nafter\n/quit\n',
      });
      expect(stdout).toContain('"prompt":"before"');
      expect(stdout).toContain('"prompt":"after"');
      expect(code).toBe(0);
    }, T);

    it.each(['generate', 'chat'])('rejects the removed cloud model for %s', async (command) => {
      const { stdout, stderr, code } = await runCli([command, '--model', 'private-cloud-compute']);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/unknown model "private-cloud-compute"/);
      expect(code).toBe(1);
    }, T);
  });

  describe('generate', () => {
    it('forwards greedy sampling alongside the token cap', async () => {
      const { stdout, code } = await runCli(['generate', '--sampling', 'greedy', '--max-tokens', '8', 'test']);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ options: { sampling: 'greedy', maxTokens: 8 } });
    }, T);

    it('passes a local image path to the image helper', async () => {
      const { stdout, stderr, code } = await runCli(['generate', '--image', 'photo.png', 'Describe it']);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ imagePath: 'photo.png', prompt: 'Describe it' });
    }, T);

    it('passes repeatable image flags in order', async () => {
      const { stdout, stderr, code } = await runCli([
        'generate', '--image', 'first.png', '--image', 'second.png', 'Compare them',
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toMatchObject({ imagePaths: ['first.png', 'second.png'], prompt: 'Compare them' });
    }, T);

    it('supports guided output with an image', async () => {
      const { stdout, code } = await runCli(['generate', '--image', 'photo.png', '--schema', SCHEMA, 'Describe it']);
      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual(expect.any(Object));
    }, T);

    it.each([
      { args: ['Beach Picnic'], input: undefined },
      { args: [], input: 'Beach Picnic\n' },
    ])('returns a JSON tag array from input $input', async ({ args, input }) => {
      const { code, stdout, stderr } = await runCli(['generate', '--use-case', 'content-tagging', ...args], { input });
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual(['beach picnic']);
    }, T);

    it('rejects tagging with a custom schema before opening the schema file', async () => {
      const { code, stdout, stderr } = await runCli([
        'generate', '--use-case', 'content-tagging', '--schema', 'absent.json',
      ]);
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toContain('content-tagging cannot be combined with --stream or --schema');
    }, T);

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
    it('routes answers to each displayed permission request and exits on EOF (AFM-FT19DR)', async () => {
      const cli = spawn(process.execPath, ['--import', 'tsx', '--import', INTERACTIVE_STDIN, CLI,
        'chat', '--no-stream', '--tools', 'read'], {
        cwd: ROOT,
        env: { ...process.env, APPLE_FM_BIN: STUB },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      cli.stdout.setEncoding('utf8');
      cli.stdout.on('data', (chunk: string) => { output += chunk; });
      const exited = new Promise<number | null>((resolve, reject) => {
        cli.once('close', resolve);
        cli.once('error', reject);
      });
      const waitForText = async (value: string): Promise<void> => {
        await vi.waitFor(() => { expect(output).toContain(value); }, { timeout: 7_000 });
      };
      try {
        await waitForText('apple-fm chat');
        cli.stdin.write(`TOOL_PAIR read ${JSON.stringify([{ path: '/first' }, { path: READ_SAMPLE }])}\n`);
        await waitForText('Run read /first?');
        expect(output).not.toContain(`Run read ${READ_SAMPLE}?`);
        cli.stdin.write('n\n');
        await waitForText(`Run read ${READ_SAMPLE}?`);
        cli.stdin.write('y\n');
        await waitForText('the-eagle-has-landed');
        expect(output).toContain('was denied by the user');
        cli.stdin.write('TOOL read {"path":"/after"}\n');
        await waitForText('Run read /after?');
        cli.stdin.end();
        await expect(exited).resolves.toBe(0);
      } finally {
        cli.stdin.end();
        if (cli.exitCode === null) cli.kill();
      }
    }, T);
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
      'runs a tool round-trip end-to-end when the tool is pre-authorized',
      async () => {
        // The stub's `TOOL <name> <jsonArgs>` sentinel makes the model "call" read;
        // the CLI's registry actually reads the fixture and feeds it back. Piped
        // input has no TTY, so the call must be pre-authorized (--allow-tool) or it
        // would be denied (default policy is ask ⇒ deny without an asker).
        // --no-stream so the REPL prints the final reply (the tool turn emits a
        // single `result`, not deltas).
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'read', '--allow-tool', 'read'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toContain('the-eagle-has-landed'); // the file content, via the tool
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'denies a tool call by default when non-interactive (piped, not pre-authorized)',
      async () => {
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'read'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toMatch(/denied by the user/); // refusal fed back, surfaced to the user
        expect(stdout).not.toContain('the-eagle-has-landed');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      '--yes auto-approves tool calls',
      async () => {
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'read', '--yes'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toContain('the-eagle-has-landed');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      '--deny-tool refuses even when --yes would allow (deny wins)',
      async () => {
        const turn = `TOOL read ${JSON.stringify({ path: READ_SAMPLE })}`;
        const { stdout, code } = await runCli(
          ['chat', '--no-stream', '--tools', 'read', '--yes', '--deny-tool', 'read'],
          { input: `${turn}\n/quit\n` },
        );
        expect(stdout).toMatch(/denied by the user/);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      '/tools lists the enabled tools',
      async () => {
        const { stdout, code } = await runCli(['chat', '--tools', 'read'], { input: '/tools\n/quit\n' });
        expect(stdout).toMatch(/tools: read/);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'runs a pre-authorized bash command and reports its output',
      async () => {
        const turn = `TOOL bash ${JSON.stringify({ command: 'echo e2e-bash-ok' })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'bash', '--allow-tool', 'bash'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toContain('e2e-bash-ok'); // the command's stdout, via the tool
        expect(stdout).toMatch(/exit code: 0/);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'denies a bash command by default when non-interactive',
      async () => {
        const turn = `TOOL bash ${JSON.stringify({ command: 'echo should-not-run' })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'bash'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toMatch(/denied by the user/);
        expect(stdout).not.toContain('should-not-run');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'does NOT blanket-approve bash under --yes (AFM-64): still denied non-interactively',
      async () => {
        // --yes auto-approves read but bash is `dangerous`, so a piped session (no TTY)
        // must still refuse it — a blanket --yes can't hand the model arbitrary exec.
        const turn = `TOOL bash ${JSON.stringify({ command: 'echo yes-should-not-run' })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'bash', '--yes'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toMatch(/denied by the user/);
        expect(stdout).not.toContain('yes-should-not-run');
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'tells the model a URL is not a local file rather than a confusing fs error (AFM-41/43)',
      async () => {
        // apple-fm has no network tool: reading a URL returns a clear message, not ENOENT.
        const turn = `TOOL read ${JSON.stringify({ path: 'https://example.com/article' })}`;
        const { stdout, code } = await runCli(['chat', '--no-stream', '--tools', 'read', '--allow-tool', 'read'], {
          input: `${turn}\n/quit\n`,
        });
        expect(stdout).toMatch(/is a URL/);
        expect(stdout).not.toMatch(/ENOENT/);
        expect(code).toBe(0);
      },
      T,
    );

    it(
      'prints (no response) instead of nothing when the model returns an empty reply (AFM-42)',
      async () => {
        const { stdout, code } = await runCli(['chat', '--no-stream'], { input: 'EMPTY\n/quit\n' });
        expect(stdout).toContain('(no response)');
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
