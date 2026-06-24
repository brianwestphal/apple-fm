/**
 * The `read` built-in tool: read a UTF-8 text file from the local filesystem.
 *
 * The low-risk built-in used to prove the FR-14 tool round-trip end-to-end. It is
 * read-only and, in phase 1, auto-runs (no permission gate yet — that is phase 2,
 * AFM-32). An optional `offset`/`limit` selects a line range so the model can page
 * a large file without pulling the whole thing into context.
 */
import { readFile } from 'node:fs/promises';

import { capOutput } from '../output.js';
import type { Tool } from '../types.js';

/** Coerce a model-supplied argument to a non-negative integer, or `undefined`. */
function intArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
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

    const content = await readFile(path, 'utf8');
    const offset = intArg(args.offset);
    const limit = intArg(args.limit);
    // Cap the returned text so a large file can't overflow the small on-device
    // context window; the model can page with offset/limit for more.
    if (offset === undefined && limit === undefined) return capOutput(content);

    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    return capOutput(lines.slice(start, end).join('\n'));
  },
};
