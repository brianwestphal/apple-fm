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
import { dirname, join } from 'node:path';
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
 * chat → a real multi-turn session, captured as structured steps so the SVG can
 * play out turn by turn. We feed the inputs on stdin (--no-stream so each reply
 * is printed whole); the REPL does not echo piped stdin, so we pair our known
 * inputs with the captured replies / `/help` output between the `> ` prompts.
 *
 * Returns `{ welcomeLines, turns: [{ input, replyLines }] }` — the typed input
 * is drawn by an overlay in the SVG, so `input` here is just the text to type.
 */
function captureChatSteps(turns) {
  const stdin = turns.map((t) => t.input).join('\n') + '\n';
  const raw = runCli(['chat', '--no-stream'], stdin);
  // Split on prompt boundaries: [welcome, out#1, out#2, ..., trailing].
  const segments = raw.split(/\n?> /);
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
      headline: 'Guided JSON output',
      subtitle:
        'Pass a JSON Schema with --schema and apple-fm returns data shaped to it — ready to pipe into the rest of your tooling.',
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
const TYPE_SPEED = 38; // ms per character (matches domotion's typing clock)
const typeMs = (s) => s.length * TYPE_SPEED;

const cmdLine = (typed) =>
  `<div class="cmdline"><span class="prompt-sym">$</span><span class="cmd">${typed ? SHELL_CMD : ''}</span></div>`;
const welcomeBlock = (lines, hidden) =>
  `<div class="welcome${hidden ? ' reveal' : ''}">${lines.map((l) => `<div class="line">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('')}</div>`;
const promptCommitted = (input) =>
  `<div class="line prompt"><span class="psym">&gt; </span>${input.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`;
const promptTyping = () => `<div class="line prompt"><span class="psym">&gt; </span><span class="cin"></span></div>`;
const replyBlock = (lines, hidden) =>
  lines.length > 0 ? `<div class="${hidden ? 'reveal rcur' : ''}">${lines.map(outputLineHtml).join('')}</div>` : '';

/**
 * Compose the chat demo as a real turn-by-turn animation. Each step is its own
 * frame (so every `typing` overlay gets a unique id): the session so far is baked
 * in as committed text, the current input is typed by the frame's lone overlay,
 * and after a brief "thinking" pause the reply fades in. Frames crossfade, so the
 * just-typed input settles into committed text as the next turn begins.
 *
 * All frames share the canvas height of the final (tallest) state and top-align,
 * so the terminal visibly grows downward as the conversation proceeds.
 */
async function buildChatSvg(demo, data) {
  const { welcomeLines, turns } = data;
  const finalLineCount = welcomeLines.length + turns.reduce((n, t) => n + 1 + t.replyLines.length, 0);
  const height = terminalHeight(finalLineCount);

  const REVEAL = 260; // reply fade-in
  const THINK = 750; // pause after a question before its reply appears
  const READ = 950; // hold after the reply before the next turn

  const frames = [
    { input: 'title.html', duration: 1800, transition: { type: 'crossfade', duration: 500 } },
  ];
  const htmls = { 'title.html': titleCardHtml({ ...demo.title, height }) };

  // Frame 1: type the shell command, reveal the welcome.
  htmls['step0.html'] = chatFrameHtml({
    title: 'apple-fm',
    body: cmdLine(false) + welcomeBlock(welcomeLines, true),
    height,
  });
  frames.push({
    input: 'step0.html',
    duration: typeMs(`${SHELL_CMD} `) + 250 + REVEAL + 650,
    transition: { type: 'crossfade', duration: 450 },
    overlays: [
      {
        kind: 'typing',
        text: `${SHELL_CMD} `,
        anchor: { selector: '.cmd', at: 'left' },
        fontSize: 15,
        color: '#e6edf3',
        speed: TYPE_SPEED,
        caret: true,
        delay: 0,
      },
    ],
    animations: [
      { selector: '.welcome', property: 'opacity', from: '0', to: '1', duration: REVEAL, delay: typeMs(`${SHELL_CMD} `) + 250 },
    ],
  });

  // One frame per turn: prior turns committed, this turn typed, its reply revealed.
  turns.forEach((turn, i) => {
    const committed = [cmdLine(true), welcomeBlock(welcomeLines, false)];
    for (let p = 0; p < i; p++) {
      committed.push(promptCommitted(turns[p].input), replyBlock(turns[p].replyLines, false));
    }
    const body = committed.join('') + promptTyping() + replyBlock(turn.replyLines, true);
    htmls[`step${i + 1}.html`] = chatFrameHtml({ title: 'apple-fm', body, height });

    const hasReply = turn.replyLines.length > 0;
    const isLast = i === turns.length - 1;
    const duration = hasReply ? typeMs(turn.input) + THINK + REVEAL + READ : typeMs(turn.input) + 700;
    frames.push({
      input: `step${i + 1}.html`,
      duration,
      transition: { type: 'crossfade', duration: 420 },
      overlays: [
        {
          kind: 'typing',
          text: turn.input,
          anchor: { selector: '.cin', at: 'left' },
          fontSize: 15,
          color: '#e6edf3',
          speed: TYPE_SPEED,
          caret: !hasReply || isLast,
          delay: 0,
        },
      ],
      animations: hasReply
        ? [{ selector: '.rcur', property: 'opacity', from: '0', to: '1', duration: REVEAL, delay: typeMs(turn.input) + THINK }]
        : [],
    });
  });

  const work = await mkdtemp(join(tmpdir(), `dm-${demo.slug}-`));
  try {
    for (const [name, html] of Object.entries(htmls)) await writeFile(join(work, name), html);
    await writeFile(
      join(work, 'config.json'),
      JSON.stringify({ width: WIDTH, height, output: join(OUT_DIR, `${demo.slug}.svg`), optimize: true, frames }, null, 2),
    );
    const r = spawnSync(DOMOTION, ['animate', join(work, 'config.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) throw new Error(`domotion failed for ${demo.slug} (exit ${r.status})`);
    process.stdout.write(`  ${demo.slug}.svg (${turns.length} turns, ${frames.length} frames)\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  for (const demo of DEMOS) {
    process.stdout.write(`capturing ${demo.slug}...\n`);
    const captured = await demo.capture();
    if (demo.chat === true) await buildChatSvg(demo, captured);
    else await buildSvg(demo, captured);
  }
  process.stdout.write(`\nWrote ${DEMOS.length} demo SVGs to assets/demos/\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
