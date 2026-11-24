import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { parseSavedChat, type SavedChat } from './session.js';

/** Publish a complete private snapshot at a new destination. */
export async function writeSavedChat(path: string, saved: SavedChat): Promise<void> {
  const destination = resolve(path);
  const staging = await mkdtemp(join(dirname(destination), '.apple-fm-save-'));
  try {
    const file = join(staging, 'session.json');
    await writeFile(file, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: 'wx' });
    await link(file, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Load and validate a snapshot before initializing the chat backend. */
export async function readSavedChat(path: string): Promise<SavedChat> {
  return parseSavedChat(await readFile(path, 'utf8'));
}
