/**
 * The `read` built-in tool: read a UTF-8 text file from the local filesystem.
 *
 * The low-risk built-in used to prove the FR-14 tool round-trip end-to-end. It is
 * read-only and permission-gated (a path grant scopes which files it may read). An
 * optional `offset`/`limit` selects a line range so the model can page a large file
 * without pulling the whole thing into context.
 *
 * The read is bounded so an approved call can't hang or exhaust memory (AFM-77): a
 * `stat` refuses non-regular files (a fifo would block forever waiting for a writer; a
 * device like `/dev/zero` streams unbounded), only a bounded prefix is pulled from
 * disk (a multi-GB file can't OOM), and a timeout backstops an exotic blocking
 * filesystem. The permission boundary is enforced against the **real** (symlink-
 * resolved) path so a symlink inside an approved directory can't escape the grant
 * (AFM-76).
 */
import { realpathSync, type Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { capOutput } from '../output.js';
import type { Tool } from '../types.js';

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

/** A human-readable name for a non-regular stat result, for the refusal message. */
function fileKind(stats: Stats): string {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFIFO()) return 'named pipe (fifo)';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isSocket()) return 'socket';
  return 'special file';
}

/**
 * Read at most `maxBytes` of a **regular** file as UTF-8. `stat` (which, unlike
 * `open`+`read`, never blocks on a fifo/device) rejects anything that isn't a regular
 * file, so a fifo can't hang and a device can't stream forever; the fixed-size read
 * bounds memory for a huge regular file (AFM-77).
 */
async function readRegularFileBounded(path: string, maxBytes: number): Promise<string> {
  const stats = await stat(path); // follows symlinks; does not block on fifo/device
  if (!stats.isFile()) {
    throw new Error(`read: "${path}" is a ${fileKind(stats)}, not a regular file — refusing to read it`);
  }
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Read a UTF-8 text file, bounded (byte cap + timeout) and clamped to the tool output
 * limit. `offset`/`limit` select a 0-based line range *within the bounded prefix*.
 * Exported so the bounding can be unit-tested with a small `maxBytes`.
 */
export async function readTextFile(
  path: string,
  range: { offset?: number; limit?: number } = {},
  options: ReadOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? READ_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const content = await withTimeout(readRegularFileBounded(path, maxBytes), timeoutMs, path);

  const { offset, limit } = range;
  // Cap the returned text so a large file can't overflow the small on-device
  // context window; the model can page with offset/limit for more.
  if (offset === undefined && limit === undefined) return capOutput(content);

  const lines = content.split('\n');
  const start = offset ?? 0;
  const end = limit !== undefined ? start + limit : lines.length;
  return capOutput(lines.slice(start, end).join('\n'));
}

/**
 * Resolve a path to its **real** (symlink-collapsed, `..`-collapsed) form for the
 * permission boundary check. A symlink inside an approved directory would otherwise
 * pass the textual boundary yet read a file outside it (AFM-76). Both the rule key and
 * the call key are resolved the same way so a legitimately symlinked prefix (e.g.
 * macOS `/tmp` → `/private/tmp`) still matches. When the path (or a component) doesn't
 * exist — a `deny` rule may name a missing file — fall back to the deepest existing
 * ancestor's real path, then to the textual resolve.
 */
function realResolve(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
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
  matchKey: (ruleKey, callKey) => {
    const rulePath = realResolve(ruleKey);
    const callPath = realResolve(callKey);
    return callPath === rulePath || callPath.startsWith(rulePath + sep);
  },
  describe: (args) => `read ${typeof args.path === 'string' ? args.path : '(no path)'}`,
  usageHint:
    'read — read a LOCAL file by its path; use it whenever the user references a file path ' +
    '(never use bash to read a file). Local files only — apple-fm cannot fetch URLs.',

  async run(args): Promise<string> {
    const path = typeof args.path === 'string' ? args.path : '';
    if (path.length === 0) throw new Error('read: "path" (string) is required');
    // A URL is not a local file: reading it throws a raw `ENOENT` that the small model
    // misreads as "the page couldn't be found". Return a clear message instead (not an
    // error) so the model doesn't treat it as a missing file (AFM-41). apple-fm has no
    // network tool, so a URL simply can't be fetched.
    if (/^https?:\/\//i.test(path)) {
      return `"${path}" is a URL, not a local file. The read tool only reads local files; apple-fm cannot fetch URLs.`;
    }

    return readTextFile(path, { offset: intArg(args.offset), limit: intArg(args.limit) });
  },
};
