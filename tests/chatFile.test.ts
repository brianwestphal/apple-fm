import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSavedChat, writeSavedChat } from '../src/chatFile.js';
import type { SavedChat } from '../src/session.js';

vi.mock('node:fs/promises', async (real) => {
  const fs = await real<{ writeFile: typeof writeFile }>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

const saved: SavedChat = { version: 1, system: 'sys', messages: [], tools: [], transcript: 'native' };

describe('chat snapshot files (AFM-VB8BK6)', () => {
  let directory: string;
  let destination: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'apple-fm-chat-file-'));
    destination = join(directory, 'chat.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('publishes a complete private file and restores it', async () => {
    await writeSavedChat(destination, saved);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    await expect(readSavedChat(destination)).resolves.toEqual(saved);
    expect(await readdir(directory)).toEqual(['chat.json']);
  });

  it('preserves an existing destination and removes the staging directory on collision', async () => {
    await writeFile(destination, 'original');
    await expect(writeSavedChat(destination, saved)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(destination, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['chat.json']);
  });

  it('removes a partial staged write and never publishes the destination', async () => {
    const fs = await vi.importActual<{ writeFile: typeof writeFile }>('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce(async (file) => {
      await fs.writeFile(file, '{"version":');
      throw new Error('simulated short write');
    });
    await expect(writeSavedChat(destination, saved)).rejects.toThrow('simulated short write');
    expect(await readdir(directory)).toEqual([]);
  });

  it('reports missing, malformed, and incompatible resume files', async () => {
    await expect(readSavedChat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(destination, '{');
    await expect(readSavedChat(destination)).rejects.toBeInstanceOf(SyntaxError);
    await writeFile(destination, JSON.stringify({ ...saved, version: 2 }));
    await expect(readSavedChat(destination)).rejects.toThrow(/unsupported.*version/);
  });
});
