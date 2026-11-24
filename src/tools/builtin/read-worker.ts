/** Private process entry point for bounded local filesystem operations. */
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

import { capOutput } from '../output.js';
import { canonicalPath } from './readPaths.js';

export interface ReadIdentity {
  path: string;
  device: string;
  inode: string;
  birth: string;
}

export type ReadSnapshot = { path: string; identity: ReadIdentity } | { path: string; error: string };
export type ReadWorkerRequest =
  | { kind: 'inspect'; path: string }
  | { kind: 'rules'; paths: string[] }
  | { kind: 'read'; identity: ReadIdentity; maxBytes: number; offset?: number; limit?: number };

function requireRegularFile(path: string, stats: BigIntStats): void {
  if (stats.isFile()) return;
  const kind = stats.isDirectory() ? 'directory' : stats.isFIFO() ? 'named pipe (fifo)' : 'special file';
  throw new Error(`read: "${path}" is a ${kind}, not a regular file — refusing to read it`);
}

export function inspectReadPath(path: string): ReadSnapshot {
  const canonical = canonicalPath(path);
  try {
    const stats = lstatSync(canonical, { bigint: true });
    requireRegularFile(canonical, stats);
    return { path: canonical, identity: {
      path: canonical, device: String(stats.dev), inode: String(stats.ino), birth: String(stats.birthtimeNs),
    } };
  } catch (error) {
    return { path: canonical, error: error instanceof Error ? error.message : String(error) };
  }
}

export function readAuthorizedFile(request: Extract<ReadWorkerRequest, { kind: 'read' }>): string {
  const { identity, maxBytes, offset, limit } = request;
  // Darwin's O_NOFOLLOW_ANY is defined in sys/fcntl.h and is not exported by Node.
  const noFollow = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
  const descriptor = openSync(identity.path, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    requireRegularFile(identity.path, stats);
    if (String(stats.dev) !== identity.device || String(stats.ino) !== identity.inode || String(stats.birthtimeNs) !== identity.birth) {
      throw new Error('read: approved file changed before it could be read');
    }
    const buffer = Buffer.alloc(maxBytes);
    const length = readSync(descriptor, buffer, 0, maxBytes, 0);
    const text = buffer.toString('utf8', 0, length);
    if (offset === undefined && limit === undefined) return capOutput(text);
    const start = offset ?? 0;
    return capOutput(text.split('\n').slice(start, limit === undefined ? undefined : start + limit).join('\n'));
  } finally {
    closeSync(descriptor);
  }
}

function execute(request: ReadWorkerRequest): ReadSnapshot | string[] | string {
  switch (request.kind) {
    case 'inspect': return inspectReadPath(request.path);
    case 'rules': return request.paths.map(canonicalPath);
    case 'read': return readAuthorizedFile(request);
  }
}

if (process.argv[2] === '--apple-fm-read-worker') {
  try {
    const request = JSON.parse(process.argv[3] ?? '') as ReadWorkerRequest;
    process.stdout.write(JSON.stringify({ value: execute(request) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}
