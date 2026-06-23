/**
 * The `read` built-in tool: read a UTF-8 text file from the local filesystem.
 *
 * The low-risk built-in used to prove the FR-14 tool round-trip end-to-end. It is
 * read-only and, in phase 1, auto-runs (no permission gate yet — that is phase 2,
 * AFM-32). An optional `offset`/`limit` selects a line range so the model can page
 * a large file without pulling the whole thing into context.
 */
import { readFile } from 'node:fs/promises';

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

  async run(args): Promise<string> {
    const path = typeof args.path === 'string' ? args.path : '';
    if (path.length === 0) throw new Error('read: "path" (string) is required');

    const content = await readFile(path, 'utf8');
    const offset = intArg(args.offset);
    const limit = intArg(args.limit);
    if (offset === undefined && limit === undefined) return content;

    const lines = content.split('\n');
    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : lines.length;
    return lines.slice(start, end).join('\n');
  },
};
