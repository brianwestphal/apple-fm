/**
 * The `read` built-in tool: read a UTF-8 text file from the local filesystem.
 *
 * The low-risk built-in used to prove the FR-14 tool round-trip end-to-end. It is
 * read-only and permission-gated (a path grant scopes which files it may read). An
 * optional `offset`/`limit` selects a line range so the model can page a large file
 * without pulling the whole thing into context.
 *
 * Filesystem metadata and reads run in a disposable process. The authorized
 * canonical path and file identity are checked against the opened descriptor.
 */
import { type ChildProcess, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { PreparedToolCall, Tool, ToolContext } from '../types.js';
import type { ReadSnapshot, ReadWorkerRequest } from './read-worker.js';
import { canonicalPath, containsPath } from './readPaths.js';

/** Coerce a model-supplied argument to a non-negative integer, or `undefined`. */
function intArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Max bytes pulled from disk for a single read. The whole file is never buffered:
 * `capOutput` clamps the *returned* text to ~3k chars, but without a read bound a
 * multi-GB file (or an endless device) would be read into memory *before* that cap
 * ever runs (AFM-77). Comfortably above the return cap so `offset`/`limit` paging has
 * headroom, while keeping the buffer bounded.
 */
const READ_MAX_BYTES = 1024 * 1024;

/** Backstop timeout for a single read (ms) — guards an exotic blocking filesystem. */
const READ_TIMEOUT_MS = 10_000;

/** Options for {@link readTextFile} (exposed so tests can shrink the bound / timeout). */
export interface ReadOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

/** Reject a promise if it hasn't settled within `ms`; a backstop against a hung read. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error(`read: timed out after ${String(ms)}ms reading "${label}"`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        res(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rej(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function runWorker<T>(request: ReadWorkerRequest, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? './read-worker.ts' : './read-worker.js', import.meta.url));
  const args = [...(source ? ['--import', 'tsx'] : []), entry, '--apple-fm-read-worker', JSON.stringify(request)];
  let child: ChildProcess | undefined;
  const work = new Promise<T>((resolve, reject) => {
    child = execFile(process.execPath, args, { signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error('read: isolated filesystem operation failed'));
          return;
        }
        try {
          const result = JSON.parse(stdout) as { value?: T; error?: string };
          if (result.value === undefined) throw new Error(result.error ?? 'read: invalid filesystem response');
          resolve(result.value);
        } catch (failure) {
          reject(failure instanceof Error ? failure : new Error(String(failure)));
        }
      });
  });
  return withTimeout(work, timeoutMs, label).finally(() => {
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  });
}

function readSnapshot(
  snapshot: ReadSnapshot, range: { offset?: number; limit?: number }, options: ReadOptions, signal?: AbortSignal,
): Promise<string> {
  if ('error' in snapshot) return Promise.reject(new Error(snapshot.error));
  return runWorker<string>({
    kind: 'read', identity: snapshot.identity, maxBytes: options.maxBytes ?? READ_MAX_BYTES, ...range,
  }, options.timeoutMs ?? READ_TIMEOUT_MS, snapshot.path, signal);
}

/** Read a bounded UTF-8 prefix or line range from the authorized regular file. */
export async function readTextFile(
  path: string,
  range: { offset?: number; limit?: number } = {},
  options: ReadOptions = {},
): Promise<string> {
  const snapshot = await runWorker<ReadSnapshot>({ kind: 'inspect', path }, options.timeoutMs ?? READ_TIMEOUT_MS, path);
  return readSnapshot(snapshot, range, options);
}

async function prepareRead(args: Record<string, unknown>, context: ToolContext): Promise<PreparedToolCall> {
  const path = typeof args.path === 'string' ? args.path : '';
  const request = { tool: 'read', key: path.length > 0 ? path : undefined, description: `read ${path || '(no path)'}`, args };
  if (path.length === 0) {
    return { request, run: () => Promise.reject(new Error('read: "path" (string) is required')) };
  }
  if (/^https?:\/\//i.test(path)) {
    return {
      request,
      run: () => Promise.resolve(`"${path}" is a URL, not a local file: the read tool only reads local files; apple-fm cannot fetch URLs.`),
    };
  }
  const snapshot = await runWorker<ReadSnapshot>({ kind: 'inspect', path }, READ_TIMEOUT_MS, path, context.signal);
  const range = { offset: intArg(args.offset), limit: intArg(args.limit) };
  return {
    request: {
      ...request,
      key: snapshot.path,
      description: `read ${snapshot.path}`,
      matchKey: containsPath,
      resolveRuleKeys: (keys) => runWorker<string[]>({ kind: 'rules', paths: keys }, READ_TIMEOUT_MS, path, context.signal),
    },
    run: () => readSnapshot(snapshot, range, {}, context.signal),
  };
}

export const readTool: Tool = {
  name: 'read',
  description:
    'Read a UTF-8 text file from the local filesystem and return its contents. ' +
    'Optionally pass a 0-based line "offset" and a "limit" number of lines to read a range.',
  parameters: {
    type: 'object',
    description: 'Arguments for the read tool.',
    required: ['path'],
    properties: {
      path: { type: 'string', description: 'Filesystem path of the file to read.' },
      offset: { type: 'integer', minimum: 0, description: 'First line to return (0-based).' },
      limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
    },
  },
  // Scope permission rules / "always" grants to the path, so a user can approve a
  // directory once (`read:/Users/me/project`) without allowing every read.
  permissionKey: (args) => (typeof args.path === 'string' ? args.path : undefined),
  // A path rule covers a file exactly or a directory and everything *inside* it — after
  // resolving `..` AND following symlinks, and only across a real path-separator
  // boundary. Resolving the **real** path (not just the textual one) is what stops a
  // symlink inside an approved dir from escaping the grant (AFM-76): `read:/proj`
  // neither leaks `/proj-secret`, lets `/proj/../.ssh/id_rsa` escape, nor lets
  // `/proj/link → /etc/shadow` read outside the boundary. Same test for allow and deny.
  matchKey: (ruleKey, callKey) => containsPath(canonicalPath(ruleKey), canonicalPath(callKey)),
  prepare: prepareRead,
  describe: (args) => `read ${typeof args.path === 'string' ? args.path : '(no path)'}`,
  usageHint:
    'read — read a LOCAL file by its path; use it whenever the user references a file path ' +
    '(never use bash to read a file). Local files only — apple-fm cannot fetch URLs.',

  async run(args, context): Promise<string> {
    const prepared = await prepareRead(args, context);
    return prepared.run();
  },
};
