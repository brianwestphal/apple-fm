#!/usr/bin/env node
/**
 * Re-capturable animated CLI demos for the README.
 *
 * Each demo runs the real built CLI (`dist/cli.js`) against the on-device model
 * and captures its actual transcript, then renders that transcript as a polished
 * animated SVG with domotion 0.15:
 *
 *   1. the captured session is replayed as an asciinema `cast` (cast.mjs) — real
 *      typing, ANSI color, cursor and timing, with a short blank lead-in;
 *   2. `domotion animate` renders that cast as a single real animated terminal
 *      frame (a single frame keeps the cast's clock in sync — see window.mjs);
 *   3. the terminal is dressed as a macOS window — drop shadow, rounded corners,
 *      traffic-light title bar — and a title card (terminal.mjs) is layered over
 *      the lead-in and fades away to reveal the terminal, all on a transparent
 *      canvas (window.mjs), so each SVG floats on any README background.
 *
 *   npm run demo                       # build + (re)generate assets/demos/*.svg
 *   node scripts/demo.mjs chat schema  # regenerate only those demos
 *
 * Because the demos run Apple's on-device model, the generated wording varies
 * slightly between captures — that is the tool's real behavior. Requires macOS
 * 26+ on Apple Silicon with Apple Intelligence enabled; domotion drives headless
 * Chromium via Playwright (installed on first use) to compose the frames.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatCast, oneShotCast } from './lib/cast.mjs';
import { titleCardSvg, WIDTH } from './lib/terminal.mjs';
import { decorateWindow, WINDOW_BAR } from './lib/window.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const HELPER = join(ROOT, 'bin', 'apple-fm-helper');
const DOMOTION = join(ROOT, 'node_modules', '.bin', 'domotion');
const OUT_DIR = join(ROOT, 'assets', 'demos');

// Terminal rendering options, shared by the size/duration pre-render and the
// cast frame so both produce an identically-sized, identically-timed terminal.
const COLS = 76;
const FONT_SIZE = 15;
const TAIL_MS = 2200; // hold on the final terminal screen before the loop
const TERM_OPTS = { theme: 'dark', fontSize: FONT_SIZE, cols: COLS, tailMs: TAIL_MS };

/** Wrap a long line on spaces so wide model output fits the terminal canvas. */
function wrap(text, width = COLS - 2) {
  const out = [];
  for (const para of text.split('\n')) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let line = '';
    for (const word of para.split(' ')) {
      if (line.length > 0 && (line + ' ' + word).length > width) {
        out.push(line);
        line = word;
      } else {
        line = line.length > 0 ? `${line} ${word}` : word;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Run the built CLI and return its stdout transcript as raw text. */
function runCli(argv, input) {
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf8',
    input,
    env: { ...process.env, APPLE_FM_BIN: HELPER },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== null) {
    throw new Error(`apple-fm exited ${r.status}: ${r.stderr}`);
  }
  return `${r.stdout}`.replace(/\n+$/, '');
}

/** probe → the single availability line. */
function captureProbe() {
  return [runCli(['probe'])];
}

/** generate → wrapped model prose. */
function captureGenerate(prompt) {
  return wrap(runCli(['generate', prompt]));
}

/** generate --schema → the structured JSON, pretty-printed when parseable. */
function captureSchema(prompt, schemaPath) {
  const raw = runCli(['generate', prompt, '--schema', schemaPath]);
  let pretty = raw;
  try {
    pretty = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Model returned non-JSON prose; show it verbatim (wrapped).
  }
  return pretty.includes('\n') ? pretty.split('\n') : wrap(pretty);
}

/**
 * Parse a captured `--no-stream` chat transcript into structured steps. The REPL
 * prints a `> ` prompt at the start of each line it's waiting on, so the prompts
 * split the transcript into `[welcome, reply#1, reply#2, …, trailing]`. We split
 * only on a prompt at the *start of a line* (`\n> `) — never a stray `> ` inside a
 * reply, e.g. the `> ` in `/help`'s `/system <text>    …` line, which an unanchored
 * split would shred. Pure (no IO) so it can be unit-tested; see tests/demo.test.ts.
 *
 * Returns `{ welcomeLines, turns: [{ input, replyLines }] }` — the typed input is
 * replayed by the cast, so `input` here is just the text to type.
 */
export function parseChatTranscript(raw, turns) {
  const segments = raw.replace(/^> /, '').split(/\n> /);
  const welcome = (segments.shift() ?? '').trim();
  return {
    welcomeLines: welcome.split('\n'),
    turns: turns.map((turn, i) => {
      const out = (segments[i] ?? '').replace(/\n+$/, '');
      const replyLines =
        out.length > 0 && turn.input !== '/quit' ? out.split('\n').flatMap((l) => wrap(l)) : [];
      return { input: turn.input, replyLines };
    }),
  };
}

/**
 * chat → a real multi-turn session captured as structured steps. We feed the
 * inputs on stdin (--no-stream so each reply prints whole); the REPL does not echo
 * piped stdin, so {@link parseChatTranscript} pairs our known inputs with the
 * captured replies / `/help` output.
 */
function captureChatSteps(turns) {
  const stdin = turns.map((t) => t.input).join('\n') + '\n';
  return parseChatTranscript(runCli(['chat', '--no-stream'], stdin), turns);
}

const SCI_FI_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    author: { type: 'string' },
    year: { type: 'integer' },
    why: { type: 'string', description: 'one sentence on why it is a classic' },
  },
  required: ['title', 'author', 'year', 'why'],
};

const DEMOS = [
  {
    slug: 'probe',
    title: {
      eyebrow: 'Availability',
      headline: 'Is the model ready?',
      subtitle:
        'apple-fm probe asks Apple Intelligence whether the on-device model is usable right now — no network, no API key.',
    },
    cmd: 'apple-fm probe',
    cast: (leadIn) => oneShotCast({ cmd: 'apple-fm probe', outputLines: captureProbe(), leadIn }),
  },
  {
    slug: 'generate',
    title: {
      eyebrow: 'Generate',
      headline: 'On-device text, one shot',
      subtitle:
        'Prompt the local model straight from your shell. Add --stream to watch tokens arrive. Runs fully offline on Apple Silicon.',
    },
    cmd: 'apple-fm generate "Explain a closure in one sentence."',
    cast: (leadIn) =>
      oneShotCast({
        cmd: 'apple-fm generate "Explain a closure in one sentence."',
        outputLines: captureGenerate('Explain what a closure is in programming, in one sentence.'),
        leadIn,
      }),
  },
  {
    slug: 'schema',
    title: {
      eyebrow: 'Structured output',
      headline: 'Guaranteed JSON output',
      subtitle:
        'Pass a JSON Schema with --schema and the output is guaranteed to conform — native guided generation, ready to pipe into the rest of your tooling.',
    },
    cmd: 'apple-fm generate "Recommend a classic sci-fi novel." --schema novel.json',
    cast: async (leadIn) => {
      const dir = await mkdtemp(join(tmpdir(), 'apple-fm-schema-'));
      const schemaPath = join(dir, 'novel.json');
      await writeFile(schemaPath, JSON.stringify(SCI_FI_SCHEMA, null, 2));
      try {
        return oneShotCast({
          cmd: 'apple-fm generate "Recommend a classic sci-fi novel." --schema novel.json',
          outputLines: captureSchema('Recommend one classic science-fiction novel.', schemaPath),
          leadIn,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  },
  {
    slug: 'chat',
    title: {
      eyebrow: 'Chat',
      headline: 'Multi-turn, auto-compacted',
      subtitle:
        'apple-fm chat keeps the conversation and summarizes older turns near the context window. Slash commands like /compact and /clear are built in, and Esc interrupts a reply mid-stream.',
    },
    cmd: 'apple-fm chat',
    cast: (leadIn) =>
      chatCast({
        ...captureChatSteps([
          { input: 'Give me a two-word tagline for an on-device AI CLI.' },
          { input: '/help' },
          { input: '/quit' },
        ]),
        leadIn,
      }),
  },
];

/** Vertical breathing room (px) added above + below the window on the canvas. */
const VMARGIN = 160;
const INTRO_MS = 2200; // how long the title card holds before it fades
const FADE_MS = 500; // title-card fade duration
// Blank lead-in baked into the cast so the terminal's first line appears just as
// the title card finishes fading away.
const LEAD_IN_S = (INTRO_MS + FADE_MS) / 1000;

/**
 * Pre-render the terminal cast with `domotion term` to learn both its pixel size
 * and its *rendered* play length. The cast frame inside `animate` loops on the
 * same term timeline, so the terminal frame must be given exactly that duration —
 * `domotion term`'s per-line frame holds make the rendered length longer than the
 * cast's raw timestamps, and the renderer's `tailMs` already holds the final
 * screen. Returns `{ width, height, durationMs }`.
 */
async function terminalRender(castPath) {
  const dir = await mkdtemp(join(tmpdir(), 'afm-dim-'));
  const tmp = join(dir, 'dim.svg');
  const r = spawnSync(
    DOMOTION,
    ['term', '--cast', castPath, '-o', tmp, '--theme', TERM_OPTS.theme, '--font-size', String(FONT_SIZE), '--cols', String(COLS), '--tail-ms', String(TAIL_MS)],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`domotion term failed:\n${r.stderr}`);
  const svg = readFileSync(tmp, 'utf8');
  await rm(dir, { recursive: true, force: true });

  const dim = /<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/.exec(svg);
  if (dim === null) throw new Error(`could not read terminal size from domotion term:\n${r.stderr}`);
  // The longest CSS animation is the reveal timeline = one full play of the cast.
  const durations = [...svg.matchAll(/animation:[^;"}]*?([0-9.]+)s/g)].map((m) => Number(m[1]));
  if (durations.length === 0) throw new Error('could not read terminal play length from domotion term');
  return { width: Number(dim[1]), height: Number(dim[2]), durationMs: Math.ceil(Math.max(...durations) * 1000) };
}

/** Compose one demo: cast → animate (single terminal frame) → window + title → SVG. */
async function buildDemo(demo) {
  const { cast } = await demo.cast(LEAD_IN_S);
  const work = await mkdtemp(join(tmpdir(), `afm-${demo.slug}-`));
  try {
    const castPath = join(work, 'session.cast');
    await writeFile(castPath, cast);

    const term = await terminalRender(castPath);
    const canvasH = term.height + WINDOW_BAR + VMARGIN;

    const config = {
      width: WIDTH,
      height: canvasH,
      output: join(work, 'composed.svg'),
      optimize: false,
      // A single cast frame: the cast's clock is anchored to the master loop, so a
      // separate title frame would desync the terminal (window.mjs explains why).
      frames: [{ cast: castPath, term: TERM_OPTS, duration: term.durationMs }],
    };
    const configPath = join(work, 'config.json');
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const r = spawnSync(DOMOTION, ['animate', configPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`domotion failed for ${demo.slug} (exit ${r.status})`);

    const titleCard = titleCardSvg({
      ...demo.title,
      canvasW: WIDTH,
      canvasH,
      coverW: term.width,
      coverH: term.height + WINDOW_BAR,
    });
    const composed = readFileSync(config.output, 'utf8');
    const decorated = decorateWindow(composed, {
      canvasW: WIDTH,
      canvasH,
      titleCard,
      introMs: INTRO_MS,
      fadeMs: FADE_MS,
    });
    await writeFile(join(OUT_DIR, `${demo.slug}.svg`), decorated);
    process.stdout.write(`  ${demo.slug}.svg (${term.width}×${term.height} terminal)\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const demos = only.size > 0 ? DEMOS.filter((d) => only.has(d.slug)) : DEMOS;
  for (const demo of demos) {
    process.stdout.write(`capturing ${demo.slug}...\n`);
    await buildDemo(demo);
  }
  process.stdout.write(`\nWrote ${demos.length} demo SVGs to assets/demos/\n`);
}

// Run only when invoked directly, not when imported by the unit tests (which
// exercise the pure cast / window helpers without touching the model).
const invokedDirectly =
  typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
