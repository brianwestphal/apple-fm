/**
 * Behavioral tests for the demo pipeline's pure pieces (`scripts/demo.mjs` +
 * `scripts/lib/*`).
 *
 * The final SVG is rendered from Apple's on-device model + domotion's headless
 * Chromium and can't run in CI, but the logic that shapes it is pure and is
 * exactly where the bugs live: how a captured transcript becomes an asciinema
 * cast (typing, ANSI color, the returned shell prompt) and how the composed SVG
 * is dressed as a window. These tests pin that logic so it can't silently regress.
 *
 * The helpers under test live in `.mjs` files (no types), so each is wrapped in a
 * locally-typed thunk that launders the `any` into a known shape.
 */
import { describe, expect, it } from 'vitest';

import { parseChatTranscript } from '../scripts/demo.mjs';
import { chatCast, colorizeLine, oneShotCast, serializeCast } from '../scripts/lib/cast.mjs';
import { decorateWindow, terminalDims, WINDOW_BAR } from '../scripts/lib/window.mjs';

const ESC = '\x1b';

interface Cast {
  cast: string;
  cols: number;
  rows: number;
  playMs: number;
}
interface Transcript {
  welcomeLines: string[];
  turns: { input: string; replyLines: string[] }[];
}
interface Dims {
  width: number;
  height: number;
}

const oneShot = (args: { cmd: string; outputLines: string[]; cols?: number }): Cast =>
  oneShotCast(args);
const chat = (args: Transcript & { cols?: number }): Cast => chatCast(args);
const color = (s: string): string => colorizeLine(s) as string;
const serialize = (header: object, events: [number, string, string][]): string =>
  serializeCast(header, events);
const parse = (raw: string, turns: { input: string }[]): Transcript =>
  parseChatTranscript(raw, turns);
const decorate = (svg: string, opts: { canvasW: number; canvasH: number; title?: string }): string =>
  decorateWindow(svg, opts);
const dims = (svg: string): Dims => terminalDims(svg);
const BAR = WINDOW_BAR as number;

/** Parse a cast string back into its header + events for assertions. */
function parseCast(text: string): { header: Record<string, unknown>; events: [number, string, string][] } {
  const [head, ...rest] = text.trimEnd().split('\n');
  return {
    header: JSON.parse(head!) as Record<string, unknown>,
    events: rest.map((l) => JSON.parse(l) as [number, string, string]),
  };
}

const dataOf = (c: Cast): string =>
  parseCast(c.cast)
    .events.map((e) => e[2])
    .join('');

describe('colorizeLine', () => {
  it('paints JSON cyan, warnings yellow, and leaves prose untouched', () => {
    expect(color('{"available":true}')).toBe(`${ESC}[36m{"available":true}${ESC}[0m`);
    expect(color('  "title": "Dune"')).toContain(`${ESC}[36m`);
    expect(color('apple-fm: model not ready')).toContain(`${ESC}[33m`);
    expect(color('A closure captures its lexical scope.')).toBe('A closure captures its lexical scope.');
  });
});

describe('oneShotCast', () => {
  const c = oneShot({ cmd: 'apple-fm probe', outputLines: ['{"available":true}'] });

  it('is a valid asciinema v2 header sized to the session', () => {
    const { header } = parseCast(c.cast);
    expect(header.version).toBe(2);
    expect(header.width).toBe(c.cols);
    expect(header.height).toBe(c.rows);
    // command line + one output line + the returned prompt.
    expect(c.rows).toBe(3);
  });

  it('types the command after a green prompt and streams the (colorized) output', () => {
    const data = dataOf(c);
    expect(data).toContain(`${ESC}[32m$${ESC}[0m `); // green shell prompt
    expect(data).toContain('apple-fm probe'); // the typed command
    expect(data).toContain(`${ESC}[36m{"available":true}${ESC}[0m`); // cyan JSON output
  });

  it('types one keystroke event per command character', () => {
    const { events } = parseCast(c.cast);
    // every single-character "o" event is a keystroke of the typed command.
    const keystrokes = events.filter((e) => e[2].length === 1);
    expect(keystrokes.length).toBe('apple-fm probe'.length);
  });

  it('advances time monotonically and reports a play length', () => {
    const { events } = parseCast(c.cast);
    const times = events.map((e) => e[0]);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(c.playMs).toBeGreaterThan(times[times.length - 1]! * 1000 - 1);
  });

  it('grows the screen so a wrapped output line never scrolls the command off', () => {
    const long = 'x'.repeat(200); // wraps to 3 rows at 76 cols
    const wide = oneShot({ cmd: 'apple-fm generate', outputLines: [long] });
    expect(wide.rows).toBe(1 + Math.ceil(200 / wide.cols) + 1);
  });
});

describe('chatCast', () => {
  const c = chat({
    welcomeLines: ['apple-fm chat — Ctrl-D or /quit to quit, /help for commands.'],
    turns: [
      { input: 'Give me a two-word tagline.', replyLines: ['Edge Genius'] },
      { input: '/help', replyLines: ['Commands:', '  /quit  Quit'] },
      { input: '/quit', replyLines: [] },
    ],
  });

  it('prints the welcome, types each prompt, and streams each reply', () => {
    const data = dataOf(c);
    expect(data).toContain('apple-fm chat —');
    expect(data).toContain(`${ESC}[32m>${ESC}[0m `); // green chat prompt
    expect(data).toContain('Give me a two-word tagline.');
    expect(data).toContain('Edge Genius');
    expect(data).toContain('Commands:');
  });

  it('returns to a green shell prompt after /quit and prints no /quit reply', () => {
    const data = dataOf(c);
    expect(data).toContain('/quit');
    // the last thing on screen is the returned `$` shell prompt.
    expect(data.trimEnd().endsWith(`${ESC}[32m$${ESC}[0m`)).toBe(true);
  });
});

describe('serializeCast', () => {
  it('emits NDJSON: a header line then one line per event', () => {
    const text = serialize({ version: 2 }, [
      [0.1, 'o', 'a'],
      [0.2, 'o', 'b'],
    ]);
    expect(text.trimEnd().split('\n')).toHaveLength(3);
  });
});

describe('parseChatTranscript', () => {
  // Anchored to a real transcript shape: a `/help` reply whose `/system <text>`
  // line contains a mid-line `> ` that an unanchored split would break on.
  const raw = [
    'apple-fm chat — Ctrl-D or /quit to quit, /help for commands.',
    '> Smart Command',
    '> Commands:',
    '  /reset [system]   Start over',
    '  /system <text>    Replace the system instructions',
    '  /quit             Quit',
    '> ',
  ].join('\n');
  const turns = [{ input: 'tagline?' }, { input: '/help' }, { input: '/quit' }];

  it('splits replies only on a line-leading prompt, keeping a mid-line "> " intact', () => {
    const { welcomeLines, turns: out } = parse(raw, turns);
    expect(welcomeLines).toEqual(['apple-fm chat — Ctrl-D or /quit to quit, /help for commands.']);
    expect(out[0]!.replyLines).toEqual(['Smart Command']);
    expect(out[1]!.replyLines).toEqual([
      'Commands:',
      '  /reset [system]   Start over',
      '  /system <text>    Replace the system instructions',
      '  /quit             Quit',
    ]);
    expect(out[2]!.replyLines).toEqual([]); // /quit prints nothing
  });
});

describe('decorateWindow', () => {
  // A minimal stand-in for a `domotion animate` output: a root <svg> with a <defs>,
  // a terminal frame (g.f-1) holding the nested cast <svg> with known dimensions.
  const composed =
    '<svg viewBox="0 0 880 360" width="880" height="360"><defs></defs>' +
    '<g class="f f-0"><rect/></g>' +
    '<g class="f f-1"><svg width="737" height="158" viewBox="0 0 737 158"><rect/></svg></g>' +
    '</svg>';

  it('reads the terminal pixel size from the nested cast svg', () => {
    expect(dims(composed)).toEqual({ width: 737, height: 158 });
  });

  it('adds a rounded clip, traffic lights and a title label', () => {
    const out = decorate(composed, { canvasW: 880, canvasH: 360, title: 'apple-fm' });
    expect(out).toContain('afm-winclip');
    // three traffic-light dots in the title bar.
    expect((out.match(/<circle /g) ?? []).length).toBe(3);
    expect(out).toContain('>apple-fm</text>');
  });

  it('pushes the terminal down by the bar height and rounds its bottom corners', () => {
    const out = decorate(composed, { canvasW: 880, canvasH: 360 });
    // the terminal frame is translated down by the title-bar height.
    const dy = Math.round((360 - (158 + BAR)) / 2);
    expect(out).toContain('clip-path="url(#afm-winclip)" transform="translate(');
    expect(out).toContain(`,${String(dy + BAR)})`);
  });

  it('throws when the composed SVG has no terminal frame', () => {
    expect(() => dims('<svg><defs></defs></svg>')).toThrow(/terminal frame/);
  });
});
