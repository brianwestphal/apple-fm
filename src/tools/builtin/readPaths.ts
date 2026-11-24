import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** Resolve symlink aliases, including a missing rule's existing parent. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function containsPath(rule: string, file: string): boolean {
  return file === rule || file.startsWith(rule.endsWith(sep) ? rule : rule + sep);
}
