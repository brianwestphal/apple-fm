/**
 * Synthesize asciinema v2 `.cast` recordings for the README demos.
 *
 * Domotion 0.15 renders a terminal recording (`domotion term` / a `cast` frame)
 * into a real, animated terminal SVG — typing, ANSI colors, cursor and timing all
 * come from the recording. So instead of hand-rolling typing overlays in HTML, we
 * capture the *real* CLI transcript (see demo.mjs) and replay it here as a cast:
 * type the command, pause to "think", then reveal the captured output line by line.
 *
 * Everything in this file is pure (string in → cast string out) so the cast shape
 * — what gets typed, the ANSI coloring, the timeline — is unit-tested without a
 * device or a browser (see tests/demo.test.ts).
 */

// ANSI SGR helpers. Casts store the ESC byte; JSON.stringify emits it as .
const ESC = '\x1b';
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const DIM = `${ESC}[90m`;
const RESET = `${ESC}[0m`;

/** A green shell prompt (`$ `). The command typed after it stays default-colored. */
export const SHELL_PROMPT = `${GREEN}\$${RESET} `;
/** A green chat prompt (`> `) for the REPL turns. */
export const CHAT_PROMPT = `${GREEN}>${RESET} `;

/**
 * Colorize one captured output line by its shape — mirrors the old CSS classes so
 * `probe` / `--schema` JSON reads cyan, warnings yellow, prose stays default. The
 * input is verbatim CLI output; we only wrap it in SGR codes.
 */
export function colorizeLine(line) {
  if (/^(apple-fm:|error)/.test(line)) return `${YELLOW}${line}${RESET}`;
  if (/^[[\]{}]/.test(line) || /^\s+"/.test(line) || /^\s*[}\]],?$/.test(line)) {
    return `${CYAN}${line}${RESET}`;
  }
  if (/^\s*•|^\s*[-*]\s/.test(line)) return `${DIM}${line}${RESET}`;
  return line;
}

/** Round to 2dp so cast timestamps stay short and stable across captures. */
const at = (t) => Math.round(t * 100) / 100;

/**
 * How many terminal rows `text` occupies at `cols` columns — the terminal hard-
 * wraps long lines, so a line longer than `cols` takes more than one row. Used to
 * size the cast's screen so nothing scrolls off the top (e.g. the typed command).
 */
const rowsFor = (text, cols) => Math.max(1, Math.ceil(text.length / cols));

/** Append per-character "type" events for `text`, returning the advanced clock. */
function typeText(events, t, text, cps) {
  const dt = 1 / cps;
  for (const ch of text) {
    t = at(t + dt);
    events.push([t, 'o', ch]);
  }
  return t;
}

/** A carriage-return + newline event (the terminal moves to the next row). */
function newline(events, t) {
  t = at(t + 0.05);
  events.push([t, 'o', '\r\n']);
  return t;
}

/** Reveal already-known output lines one at a time so they appear to stream in. */
function revealLines(events, t, lines, { stagger, colorize = true }) {
  for (const line of lines) {
    t = at(t + stagger);
    events.push([t, 'o', `${colorize ? colorizeLine(line) : line}\r\n`]);
  }
  return t;
}

/** Serialize a header + event list into asciinema v2 cast text (NDJSON). */
export function serializeCast(header, events) {
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n';
}

/** Timing constants shared by both cast shapes (seconds). */
const START = 0.4; // beat before the first prompt appears
const CMD_CPS = 22; // command typing speed (chars/sec)
const THINK = 0.6; // pause after Enter before output streams
const STAGGER = 0.16; // delay between revealed output lines
const TURN_GAP = 0.7; // beat between a reply and the next typed prompt

/**
 * A single-command session: green `$` prompt, the typed command, a think beat,
 * then the captured output streamed line by line, ending back at a prompt.
 *
 * Returns `{ cast, cols, rows, playMs }` — `playMs` sizes the demo's terminal
 * frame, `rows`/`cols` size the cast's screen.
 */
export function oneShotCast({ cmd, outputLines, cols = 76, leadIn = 0 }) {
  const events = [];
  let t = START;
  // Show the prompt from the start, then hold for the lead-in. The held frame is
  // what the title card covers; `domotion term` collapses a *leading* idle (no
  // content yet), so the hold must come after something is on screen.
  events.push([t, 'o', SHELL_PROMPT]);
  t = at(t + leadIn);
  t = typeText(events, t, cmd, CMD_CPS);
  t = newline(events, t);
  t = at(t + THINK);
  t = revealLines(events, t, outputLines, { stagger: STAGGER });
  t = at(t + 0.3);
  events.push([t, 'o', SHELL_PROMPT]);

  // The screen must fit the command line, every (wrapped) output line, and the
  // returned prompt, or the terminal scrolls and the command is lost off the top.
  const rows =
    rowsFor(`$ ${cmd}`, cols) +
    outputLines.reduce((n, l) => n + rowsFor(l, cols), 0) +
    1;
  return { cast: serializeCast(header(cols, rows), events), cols, rows, playMs: Math.ceil(t * 1000) };
}

/**
 * A multi-turn chat session: the welcome line, then each turn types its `> `
 * prompt, thinks, and streams its reply; after `/quit` the REPL hands the
 * terminal back to a green `$` shell prompt. `turns` is
 * `[{ input, replyLines }]` (see demo.mjs's parseChatTranscript).
 */
export function chatCast({ welcomeLines, turns, cols = 76, leadIn = 0 }) {
  const events = [];
  let t = START;
  // The welcome banner is printed by the REPL before the first prompt; it shows
  // from the start, then a held lead-in (what the title card covers — see
  // oneShotCast for why a *leading* idle would be collapsed by `domotion term`).
  t = revealLines(events, t, welcomeLines, { stagger: 0.05, colorize: false });
  t = at(t + leadIn);
  let rows = welcomeLines.reduce((n, l) => n + rowsFor(l, cols), 0);

  for (const turn of turns) {
    t = at(t + TURN_GAP);
    events.push([t, 'o', CHAT_PROMPT]);
    t = typeText(events, t, turn.input, CMD_CPS);
    t = newline(events, t);
    rows += rowsFor(`> ${turn.input}`, cols);
    if (turn.input === '/quit') break;
    t = at(t + THINK);
    t = revealLines(events, t, turn.replyLines, { stagger: STAGGER, colorize: false });
    rows += turn.replyLines.reduce((n, l) => n + rowsFor(l, cols), 0);
  }

  // The REPL exits on /quit; the shell prompt returns underneath.
  t = at(t + 0.4);
  events.push([t, 'o', SHELL_PROMPT]);
  rows += 1;

  return { cast: serializeCast(header(cols, rows), events), cols, rows, playMs: Math.ceil(t * 1000) };
}

/** asciinema v2 header. `timestamp` is fixed so captures diff cleanly. */
function header(cols, rows) {
  return { version: 2, width: cols, height: rows, timestamp: 0, env: { TERM: 'xterm-256color' } };
}
