/**
 * HTML scaffolding for the animated README demos.
 *
 * Each demo is two frames composed by `domotion animate`: a title card that
 * introduces the concept, then a macOS-style terminal window that types the
 * command and reveals the *real* captured CLI output (apple-fm's on-device
 * generation). Both frames share one canvas size so the crossfade between them
 * is seamless.
 *
 * Nothing here renders pixels — it only emits HTML/CSS that domotion captures in
 * Chromium. Colors track GitHub's dark theme so the SVGs read well in the README.
 */

/** Shared canvas width for every demo SVG (px). */
export const WIDTH = 860;

/** Terminal vertical metrics (px) — used to size the canvas to the content. */
const BAR_H = 38;
const BODY_PAD_TOP = 18;
const BODY_PAD_BOTTOM = 20;
const CMD_LINE_H = 26;
const CMD_GAP = 12;
const LINE_H = 22;

/** Height that fits a terminal with `lineCount` output lines. */
export function terminalHeight(lineCount) {
  return BAR_H + BODY_PAD_TOP + CMD_LINE_H + CMD_GAP + lineCount * LINE_H + BODY_PAD_BOTTOM;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap one captured output line in a colored `<div>`. The text is verbatim from
 * the CLI; only presentation classes are added based on the line's shape, so the
 * JSON of `probe` / `--schema` and the chat prompts read distinctly.
 */
function lineToHtml(line) {
  let cls = '';
  if (/^>\s/.test(line)) cls = 'prompt'; // chat prompt + typed input
  else if (/^(apple-fm:|error)/.test(line)) cls = 'warn'; // stderr / errors
  else if (/^[[\]{}]/.test(line) || /^\s+"/.test(line) || /^\s*[}\]],?$/.test(line)) cls = 'json';
  else if (/^\s*•|^\s*[-*]\s/.test(line)) cls = 'li'; // bullets
  return `<div class="line ${cls}">${esc(line)}</div>`;
}

const SHELL = `
  *{box-sizing:border-box}
  html,body{margin:0;background:#010409}
  .stage{width:${WIDTH}px;display:flex;flex-direction:column}
`;

/** The introductory title card. */
export function titleCardHtml({ eyebrow, headline, subtitle, height }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${SHELL}
  .stage{height:${height}px;justify-content:center;align-items:center;
    background:radial-gradient(130% 130% at 0% 0%,#1b2433 0%,#0d1117 58%);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center}
  .eyebrow{color:#7ee787;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.24em;text-transform:uppercase}
  h1{color:#e6edf3;font-size:30px;line-height:1.15;margin:14px 0 0;font-weight:700}
  p{color:#8b949e;font-size:15px;line-height:1.5;margin:11px 0 0;max-width:600px}
  </style></head><body><div class="stage">
    <div class="eyebrow">${esc(eyebrow)}</div>
    <h1>${headline}</h1>
    <p>${esc(subtitle)}</p>
  </div></body></html>`;
}

/**
 * The terminal window. The command line is intentionally empty in the DOM — the
 * `typing` overlay draws it character by character — and the output starts
 * visible so domotion captures it, then per-frame opacity animations drive it:
 * `.outbody` is revealed once the command has finished "running", and the
 * wrapping `.out` is faded back out at the end of the frame so the output
 * disappears in lockstep with the typed command (which domotion self-erases just
 * before the loop). Reveal and fade target two elements so their `animation`
 * shorthands don't clash on one node.
 */
/** Public form of {@link lineToHtml} — used by demo.mjs to build chat frames. */
export function outputLineHtml(line) {
  return lineToHtml(line);
}

/**
 * A single frame of the multi-step chat demo. `body` is prebuilt HTML (the
 * session so far, top-aligned) assembled by demo.mjs: committed lines are plain;
 * the current input's `.cin` span is an empty anchor the frame's lone `typing`
 * overlay fills, and any not-yet-revealed block carries `.reveal` (opacity 0)
 * for an `animations` entry to fade in. Each turn is its own frame so every
 * `typing` overlay gets a unique id (domotion keys overlay ids by frame index).
 */
export function chatFrameHtml({ title, body, height }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${SHELL}
  .stage{height:${height}px;background:#0d1117}
  .bar{height:${BAR_H}px;display:flex;align-items:center;gap:8px;padding:0 14px;
    background:#161b22;border-bottom:1px solid #21262d;flex:0 0 auto}
  .dot{width:12px;height:12px;border-radius:50%}
  .r{background:#ff5f56}.y{background:#febc2e}.g{background:#28c840}
  .name{color:#8b949e;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;margin-left:8px}
  .body{padding:${BODY_PAD_TOP}px 20px ${BODY_PAD_BOTTOM}px;
    font:15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3}
  .cmdline{height:${CMD_LINE_H}px;display:flex;align-items:center}
  .prompt-sym{color:#7ee787;margin-right:9px;font-weight:600}
  .cmd{display:inline-block;min-width:1px}
  .cin{display:inline-block;min-width:1px}
  .shellcur{display:inline-block;min-width:1px;height:${LINE_H}px}
  .welcome{margin-top:${CMD_GAP}px}
  .line{height:${LINE_H}px;line-height:${LINE_H}px;white-space:pre}
  .prompt{color:#e6edf3}
  .psym{color:#7ee787;font-weight:600}
  .json{color:#a5d6ff}
  .li{color:#c9d1d9}
  .warn{color:#febc2e}
  </style></head><body><div class="stage">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="name">${esc(title)}</span></div>
    <div class="body">${body}</div>
  </div></body></html>`;
}

export function terminalHtml({ title, outputLines, height }) {
  const out = outputLines.map(lineToHtml).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${SHELL}
  .stage{height:${height}px;background:#0d1117}
  .bar{height:${BAR_H}px;display:flex;align-items:center;gap:8px;padding:0 14px;
    background:#161b22;border-bottom:1px solid #21262d;flex:0 0 auto}
  .dot{width:12px;height:12px;border-radius:50%}
  .r{background:#ff5f56}.y{background:#febc2e}.g{background:#28c840}
  .name{color:#8b949e;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;margin-left:8px}
  .body{padding:${BODY_PAD_TOP}px 20px ${BODY_PAD_BOTTOM}px;
    font:15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3}
  .cmdline{height:${CMD_LINE_H}px;display:flex;align-items:center}
  .prompt-sym{color:#7ee787;margin-right:9px;font-weight:600}
  .cmd{display:inline-block;min-width:1px}
  .out{margin-top:${CMD_GAP}px;opacity:1}
  .outbody{opacity:1}
  .line{height:${LINE_H}px;line-height:${LINE_H}px;white-space:pre}
  .json{color:#a5d6ff}
  .prompt{color:#7ee787}
  .li{color:#c9d1d9}
  .warn{color:#febc2e}
  </style></head><body><div class="stage">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span><span class="name">${esc(title)}</span></div>
    <div class="body">
      <div class="cmdline"><span class="prompt-sym">$</span><span class="cmd"></span></div>
      <div class="out"><div class="outbody">${out}</div></div>
    </div>
  </div></body></html>`;
}
