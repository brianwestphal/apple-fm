#!/usr/bin/env node
/**
 * Re-capturable animated CLI demos for the README.
 *
 * Each demo runs the real built CLI (`dist/cli.js`) against the on-device model,
 * captures its actual transcript, then renders that into a self-contained
 * animated terminal SVG with `domotion-svg`: a title card introducing the
 * concept, then a terminal that types the command and reveals the captured
 * output.
 *
 *   npm run demo                       # build + (re)generate assets/demos/*.svg
 *
 * The SVGs embedded in README.md are this script's output. Because the demos run
 * Apple's on-device model, the generated wording varies slightly between
 * captures — that is the tool's real behavior. Requires macOS 26+ on Apple
 * Silicon with Apple Intelligence enabled (the same requirement as apple-fm
 * itself); rendering drives headless Chromium via Playwright (domotion installs
 * it on first use).
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  chatFrameHtml,
  outputLineHtml,
  terminalHeight,
  terminalHtml,
  titleCardHtml,
  WIDTH,
} from './lib/terminal.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const HELPER = join(ROOT, 'bin', 'apple-fm-helper');
const DOMOTION = join(ROOT, 'node_modules', '.bin', 'domotion');
const OUT_DIR = join(ROOT, 'assets', 'demos');

/** Wrap a long line on spaces so wide model output fits the terminal canvas. */
function wrap(text, width = 74) {
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
  const text = runCli(['generate', prompt]);
  return wrap(text);
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
 * drawn by an overlay in the SVG, so `input` here is just the text to type.
 */
export function parseChatTranscript(raw, turns) {
  // Anchor the split to line starts; a leading prompt (no preceding newline) is
  // normalized first so the welcome segment is captured consistently.
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
 * chat → a real multi-turn session, captured as structured steps so the SVG can
 * play out turn by turn. We feed the inputs on stdin (--no-stream so each reply is
 * printed whole); the REPL does not echo piped stdin, so {@link parseChatTranscript}
 * pairs our known inputs with the captured replies / `/help` output.
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
    capture: () => captureProbe(),
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
    capture: () => captureGenerate('Explain what a closure is in programming, in one sentence.'),
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
    capture: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'apple-fm-schema-'));
      const schemaPath = join(dir, 'novel.json');
      await writeFile(schemaPath, JSON.stringify(SCI_FI_SCHEMA, null, 2));
      try {
        return captureSchema('Recommend one classic science-fiction novel.', schemaPath);
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
        'apple-fm chat keeps the conversation and summarizes older turns near the context window. Slash commands like /compact and /clear are built in.',
    },
    cmd: 'apple-fm chat',
    chat: true, // composed turn-by-turn by buildChatSvg
    capture: () =>
      captureChatSteps([
        { input: 'Give me a two-word tagline for an on-device AI CLI.' },
        { input: '/help' },
        { input: '/quit' },
      ]),
  },
];

/**
 * Compose one demo into an animated SVG: write the two frame HTML files and a
 * domotion `animate` config into a temp dir, then shell out to the installed
 * `domotion` CLI to capture and stitch them.
 */
async function buildSvg(demo, lines) {
  const height = terminalHeight(lines.length);
  const work = await mkdtemp(join(tmpdir(), `dm-${demo.slug}-`));
  try {
    const titleHtml = join(work, 'title.html');
    const termHtml = join(work, 'term.html');
    const config = join(work, 'config.json');
    await writeFile(titleHtml, titleCardHtml({ ...demo.title, height }));
    await writeFile(termHtml, terminalHtml({ title: 'apple-fm', outputLines: lines, height }));

    const speed = 26; // characters per second
    const typeMs = Math.ceil((demo.cmd.length / speed) * 1000);
    const revealDelay = typeMs + 350; // let the command settle before output appears
    const termDuration = revealDelay + 300 + 3800; // reveal + hold
    const outHideDelay = termDuration - 150; // fade output as the typed command self-erases

    await writeFile(
      config,
      JSON.stringify(
        {
          width: WIDTH,
          height,
          output: join(OUT_DIR, `${demo.slug}.svg`),
          optimize: true,
          frames: [
            {
              input: 'title.html',
              duration: 1800,
              transition: { type: 'crossfade', duration: 500 },
            },
            {
              input: 'term.html',
              duration: termDuration,
              transition: { type: 'crossfade', duration: 500 },
              overlays: [
                {
                  kind: 'typing',
                  text: `${demo.cmd} `,
                  anchor: { selector: '.cmd', at: 'left' },
                  fontSize: 15,
                  color: '#e6edf3',
                  speed,
                  caret: true,
                },
              ],
              animations: [
                {
                  selector: '.outbody',
                  property: 'opacity',
                  from: '0',
                  to: '1',
                  duration: 300,
                  delay: revealDelay,
                },
                {
                  selector: '.out',
                  property: 'opacity',
                  from: '1',
                  to: '0',
                  duration: 100,
                  delay: outHideDelay,
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    const r = spawnSync(DOMOTION, ['animate', config], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (r.status !== 0) throw new Error(`domotion failed for ${demo.slug} (exit ${r.status})`);
    process.stdout.write(`  ${demo.slug}.svg (${lines.length} lines)\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const SHELL_CMD = 'apple-fm chat';
const TYPE_SPEED = 38; // ms per character (domotion reads `speed` as ms/char)
const typeMs = (s) => s.length * TYPE_SPEED;

// domotion fades a finished typing overlay out `disappearGap` ms (150) before its
// frame ends; we pad a typing frame by this much past the keystrokes so the typed
// line stays whole right up to the `cut` that commits it.
const TAIL = 170;
// `at:'left'` anchors overlay text by its box's vertical *center*, but committed
// HTML text sits on a lower baseline; this nudge drops the typed text onto that
// baseline so the live command/prompt lines up with its `$` / `>` and with the
// committed copy it cuts to.
const TYPE_DY = 4;

const TYPED = (sel) => ({
  kind: 'typing',
  anchor: { selector: sel, at: 'left', dy: TYPE_DY },
  fontSize: 15,
  color: '#e6edf3',
  speed: TYPE_SPEED,
  caret: true,
});
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// The shell command line: a green `$`, then either the empty `.cmd` the overlay
// types into, or the committed text once typed.
const cmdTyping = () => `<div class="cmdline"><span class="prompt-sym">$</span><span class="cmd"></span></div>`;
const cmdDone = () => `<div class="cmdline"><span class="prompt-sym">$</span><span class="cmd">${SHELL_CMD}</span></div>`;
const welcomeBlock = (lines) =>
  `<div class="welcome">${lines.map((l) => `<div class="line">${escHtml(l)}</div>`).join('')}</div>`;
// A chat prompt line: `> `, then the empty `.cin` the overlay types into, or the
// committed input once typed.
const promptTyping = () => `<div class="line prompt"><span class="psym">&gt; </span><span class="cin"></span></div>`;
const promptDone = (input) => `<div class="line prompt"><span class="psym">&gt; </span>${escHtml(input)}</div>`;
const replyBlock = (lines) =>
  lines.length > 0 ? `<div>${lines.map(outputLineHtml).join('')}</div>` : '';
// The shell prompt the terminal returns to once the chat REPL exits (after /quit).
// Built from `.cmdline` so its `$` renders like the opening command; the empty
// `.shellcur` anchors the blinking block cursor overlay.
const shellReturn = () =>
  `<div class="cmdline"><span class="prompt-sym">$</span><span class="shellcur"></span></div>`;

/**
 * Build the chat demo's frame spec and per-frame HTML — pure, no IO, so the
 * animation's behavior can be unit-tested (see tests/demo.test.ts).
 *
 * Two hard constraints from domotion shape the whole design:
 * - A `typing` overlay's id is keyed by frame index, so each frame can type at
 *   most one line — hence one frame per typed command/prompt.
 * - Fully-transparent elements are dropped from the capture and per-frame opacity
 *   "reveals" don't play back reliably, so nothing fades in: every line is
 *   *committed* (fully visible) in the frame where it first appears, and new
 *   content simply appears at a `cut`.
 *
 * So each turn is two frames: a **type** frame whose overlay types the prompt (a
 * blinking caret, nudged onto the text baseline by `TYPE_DY`), then a **show**
 * frame — cut to instantly — where that prompt is committed and the reply appears
 * beneath it. Frames hard-`cut` (never crossfade) so the committed transcript
 * stays rock-steady; a crossfade dips the whole canvas, which is what made the old
 * demo look like the app blinking out and back. After `/quit` the show frame adds
 * a blinking `$` shell prompt, so the REPL reads as exiting and handing the
 * terminal back.
 *
 * All frames share the canvas height of the final (tallest) state and top-align,
 * so the terminal visibly grows downward as the conversation proceeds.
 */
export function buildChatFrames(demo, data) {
  const { welcomeLines, turns } = data;
  // +1 line for the returned shell prompt shown once the REPL exits.
  const finalLineCount =
    welcomeLines.length + turns.reduce((n, t) => n + 1 + t.replyLines.length, 0) + 1;
  const height = terminalHeight(finalLineCount);

  const CMD_DELAY = 300; // beat before the command starts typing
  const PRE = 460; // beat with the bare `>` prompt showing before a turn types
  const THINK = 720; // beat the typed prompt holds before its reply appears
  const READ = 1500; // hold on a reply so there's room to read before the next turn

  const frames = [
    { input: 'title.html', duration: 1700, transition: { type: 'crossfade', duration: 500 } },
  ];
  const htmls = { 'title.html': titleCardHtml({ ...demo.title, height }) };
  const frame = (input, body, opts = {}) => {
    htmls[input] = chatFrameHtml({ title: 'apple-fm', body, height });
    frames.push({ input, transition: { type: 'cut', duration: 0 }, ...opts });
  };

  // The transcript committed so far, grown as the conversation proceeds. Each
  // `show` frame renders `committed` verbatim, so consecutive frames share an
  // identical, identically-placed transcript and the `cut`s are invisible.
  const committed = [];
  const welcome = welcomeBlock(welcomeLines);

  // Type the shell command — the title frame crossfades into this one — then cut
  // to a frame with the command committed and the welcome printed beneath it.
  frame('cmd-type.html', cmdTyping(), {
    duration: CMD_DELAY + typeMs(SHELL_CMD) + TAIL,
    overlays: [{ ...TYPED('.cmd'), text: SHELL_CMD, delay: CMD_DELAY }],
  });
  committed.push(cmdDone(), welcome);
  frame('welcome.html', committed.join(''), { duration: 900 });

  turns.forEach((turn, i) => {
    const isLast = i === turns.length - 1;

    // Type frame: the transcript so far + the bare `>` prompt the overlay fills in.
    frame(`type${i}.html`, committed.join('') + promptTyping(), {
      duration: PRE + typeMs(turn.input) + THINK + TAIL,
      overlays: [{ ...TYPED('.cin'), text: turn.input, delay: PRE }],
    });

    // Show frame: commit the prompt, print its reply (and, after /quit, hand the
    // terminal back to a blinking `$`). A short last hold then loops to the title.
    committed.push(promptDone(turn.input));
    if (turn.replyLines.length > 0) committed.push(replyBlock(turn.replyLines));
    const body = committed.join('') + (isLast ? shellReturn() : '');
    frame(`show${i}.html`, body, {
      duration: isLast ? 2200 : READ,
      ...(isLast ? { transition: { type: 'crossfade', duration: 600 } } : {}),
      ...(isLast
        ? {
            overlays: [
              {
                kind: 'blink',
                anchor: { selector: '.shellcur', at: 'left', dy: -4 },
                width: 9,
                height: 17,
                color: '#e6edf3',
                periodMs: 1100,
                delay: 500,
              },
            ],
          }
        : {}),
    });
  });

  return { height, frames, htmls };
}

/** Render the chat demo: build its frames, then capture them with domotion. */
async function buildChatSvg(demo, data) {
  const { height, frames, htmls } = buildChatFrames(demo, data);
  const work = await mkdtemp(join(tmpdir(), `dm-${demo.slug}-`));
  try {
    for (const [name, html] of Object.entries(htmls)) await writeFile(join(work, name), html);
    await writeFile(
      join(work, 'config.json'),
      JSON.stringify({ width: WIDTH, height, output: join(OUT_DIR, `${demo.slug}.svg`), optimize: true, frames }, null, 2),
    );
    const r = spawnSync(DOMOTION, ['animate', join(work, 'config.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`domotion failed for ${demo.slug} (exit ${r.status})`);
    process.stdout.write(`  ${demo.slug}.svg (${data.turns.length} turns, ${frames.length} frames)\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  // `node scripts/demo.mjs chat schema` regenerates only those demos; no args
  // regenerates all. Handy for iterating on a single demo without re-running the
  // model for every one.
  const only = new Set(process.argv.slice(2));
  const demos = only.size > 0 ? DEMOS.filter((d) => only.has(d.slug)) : DEMOS;
  for (const demo of demos) {
    process.stdout.write(`capturing ${demo.slug}...\n`);
    const captured = await demo.capture();
    if (demo.chat === true) await buildChatSvg(demo, captured);
    else await buildSvg(demo, captured);
  }
  process.stdout.write(`\nWrote ${demos.length} demo SVGs to assets/demos/\n`);
}

// Run only when invoked directly (`node scripts/demo.mjs`), not when imported by
// the unit tests, which exercise buildChatFrames() without touching the model.
const invokedDirectly =
  typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
