/** AFM-T8C35G: exercise the built CLI and helper on an Apple Intelligence Mac. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, LiveSession, PermissionPolicy, probe, registryFromNames } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const imageFixtures = {
  red: 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABC0lEQVR4nO3OMQ0AIAAEsfdvGhyw9gaSCujO9j34QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UHcBWwZ3g5gacwjAAAAAElFTkSuQmCC',
  blue: 'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABC0lEQVR4nO3OMQ0AIAAEsfdvGhyw9gaSCui28z35QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UGcH8T5QZwfxPlBnB/E+UHaBa/h3g7Hpj8QAAAAAElFTkSuQmCC',
};

function runCli(args, input) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', input, timeout: 130_000 });
}

async function checkImages(directory) {
  const major = Number(execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]);
  if (major < 27) {
    console.log('Image check requires macOS 27');
    return;
  }
  const paths = await Promise.all(Object.entries(imageFixtures).map(async ([name, png]) => {
    const path = join(directory, `${name}.png`);
    await writeFile(path, Buffer.from(png, 'base64'));
    return path;
  }));
  const schema = join(directory, 'colors.json');
  await writeFile(schema, JSON.stringify({
    type: 'object',
    required: ['colors'],
    properties: { colors: { type: 'array', items: { type: 'string', enum: ['red', 'blue'] }, minItems: 2, maxItems: 2 } },
  }));
  const output = runCli(['generate', 'List each image’s solid color in attachment order.', '--schema', schema,
    ...paths.flatMap((path) => ['--image', path])]);
  assert.deepEqual(JSON.parse(output).colors, ['red', 'blue']);
  console.log('PASS multiple images and guided colors');
}

const directory = await mkdtemp(join(tmpdir(), 'apple-fm-device-smoke-'));
try {
  const availability = await probe();
  assert.ok(availability.available, `Enable Apple Intelligence and wait for model assets (${availability.reason ?? 'unavailable'})`);
  assert.deepEqual(JSON.parse(runCli(['probe'])).models.map(({ id }) => id), ['on-device']);
  console.log('PASS on-device model discovery');

  const deltas = [];
  const text = await generate({ prompt: 'Reply with the single word sunlight.', stream: true }, {}, (delta) => deltas.push(delta));
  assert.match(text, /sunlight/i);
  assert.ok(deltas.length > 0);
  assert.equal(deltas.join(''), text);
  console.log('PASS streamed text generation');

  const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'integer', minimum: 2, maximum: 2 } } };
  const structured = await generate({ prompt: 'What is one plus one?', schema });
  assert.deepEqual(JSON.parse(structured), { answer: 2 });
  console.log('PASS native guided generation');

  const notes = join(directory, 'notes.txt');
  const marker = randomBytes(5).toString('hex');
  await writeFile(notes, marker, { mode: 0o600 });
  const live = new LiveSession({
    tools: registryFromNames(['read']),
    permission: new PermissionPolicy({ allow: [`read:${notes}`] }),
  });
  try {
    await live.reset('Use the read tool whenever the user references a local file. Return the file contents verbatim.');
    const chunks = [];
    const reply = await live.send(`Read the exact contents of ${notes} and reply with those contents.`, (delta) => chunks.push(delta));
    assert.ok(reply.includes(marker), 'streamed chat did not return the file contents');
    assert.equal(chunks.join(''), reply);
  } finally {
    live.close();
  }
  console.log('PASS permission-gated tool round-trip during streaming');

  const saved = join(directory, 'saved.json');
  const resumed = join(directory, 'resumed.json');
  const seed = 'Remember that the launch code is pelican. Reply OK.';
  assert.match(runCli(['chat', '--no-stream'], `${seed}\n/save ${saved}\n/quit\n`), /\(saved\)/);
  assert.match(runCli(['chat', '--resume', saved, '--no-stream'], `What is the launch code?\n/save ${resumed}\n/quit\n`), /pelican/i);
  const snapshot = JSON.parse(await readFile(resumed, 'utf8'));
  assert.equal(snapshot.messages[0].content, seed);
  assert.equal(snapshot.messages.length, 4);
  console.log('PASS save and resume with native transcript');

  await checkImages(directory);
} finally {
  await rm(directory, { recursive: true, force: true });
}
