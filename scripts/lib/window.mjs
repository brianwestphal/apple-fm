/**
 * Turn a `domotion animate` output into the finished demo: dress the terminal as
 * a macOS window and lay a title card over the opening beat.
 *
 * Each demo is a single `cast` frame — domotion renders the terminal as a *nested*
 * animated `<svg>`, an opaque rectangle at the frame's top-left, with no notion of
 * window chrome. A single frame is deliberate: a cast's animation clock is anchored
 * to the master loop's origin and runs at its own period, so a *separate* title
 * frame would desync the terminal (it would only ever show the back half of the
 * session). Instead we keep one in-sync cast frame and, in post-processing, add:
 *
 *   - rounded corners and a traffic-light title bar (the window);
 *   - a title card layered on top that fades out over the cast's lead-in (and back
 *     in over the loop seam), so the demo opens on the title and the terminal plays
 *     underneath it.
 *
 * It's a pure string transform keyed off domotion's stable output shape (a frame is
 * `<g class="f f-N">`; the cast frame is the one wrapping a nested `<svg>`), so it's
 * unit-tested (see tests/demo.test.ts). Pinned to the `domotion-svg` version in
 * package.json; revisit if that output shape changes.
 */

const BAR = 34; // title-bar height (px)
const RADIUS = 11; // window corner radius (px)

/**
 * Locate the cast (terminal) frame in a composed SVG: the frame group
 * `<g class="f f-N">` that wraps the nested terminal `<svg>`. Returns the group's
 * class suffix (`f-N`), the byte offset of its opening tag, and the nested
 * terminal's pixel size.
 */
function findCastFrame(svg) {
  const re = /<g class="f (f-\d+)">/g;
  let m;
  while ((m = re.exec(svg)) !== null) {
    const start = m.index + m[0].length;
    const next = svg.indexOf('<g class="f f-', start);
    const region = svg.slice(start, next === -1 ? undefined : next);
    const dim = /<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"[^>]*\bheight="(\d+(?:\.\d+)?)"/.exec(region);
    if (dim !== null) {
      return {
        cls: m[1],
        tag: m[0],
        at: m.index,
        width: Math.round(Number(dim[1])),
        height: Math.round(Number(dim[2])),
      };
    }
  }
  throw new Error('window: no terminal frame (a g.f-N wrapping a nested <svg>) in composed SVG');
}

/** The terminal's pixel size, read from the nested cast `<svg>` it wraps. */
export function terminalDims(svg) {
  const { width, height } = findCastFrame(svg);
  return { width, height };
}

/**
 * Finish the composed demo SVG: dress the terminal frame as a window and lay a
 * fading title card over the opening.
 *
 * @param svg - the raw single-cast-frame `domotion animate` output.
 * @param opts.canvasW / opts.canvasH - the animate canvas size (to center the window).
 * @param opts.title - the title-bar label (e.g. `apple-fm`).
 * @param opts.titleCard - SVG markup (a captured title card) to lay over the opening.
 * @param opts.introMs / opts.fadeMs - how long the title card holds, then fades.
 * @returns the finished SVG.
 */
export function decorateWindow(
  svg,
  { canvasW, canvasH, title = 'apple-fm', titleCard, introMs = 2200, fadeMs = 500 } = {},
) {
  const frame = findCastFrame(svg);
  const tw = frame.width;
  const th = frame.height;
  const winH = th + BAR;
  const dx = Math.round((canvasW - tw) / 2);
  const dy = Math.round((canvasH - winH) / 2);

  // A clip that rounds only the bottom corners — the top sits flush under the bar.
  const botClip =
    `M0 0 H${tw} V${th - RADIUS} a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} ${RADIUS} ` +
    `H${RADIUS} a${RADIUS} ${RADIUS} 0 0 1 -${RADIUS} -${RADIUS} Z`;
  const defs = `<clipPath id="afm-winclip"><path d="${botClip}"/></clipPath>`;
  let out = svg.replace('<defs>', `<defs>${defs}`);
  if (out === svg) throw new Error('window: no <defs> to extend in composed SVG');

  // A solid rounded backing behind the window (bar + body) so it has a clean
  // edge with no seams; it shares the cast frame's visibility class so it shows
  // exactly when the terminal does.
  const backing =
    `<g class="f ${frame.cls}" transform="translate(${dx},${dy})">` +
    `<rect x="0" y="0" width="${tw}" height="${winH}" rx="${RADIUS}" fill="#0d1117"/></g>`;
  // Push the terminal down by the bar height and round its bottom corners.
  out = out.replace(
    frame.tag,
    `${backing}<g class="f ${frame.cls}" clip-path="url(#afm-winclip)" transform="translate(${dx},${dy + BAR})">`,
  );

  // The title bar (rounded top), traffic lights, centered label, and 1px border.
  const barPath =
    `M0 ${BAR} V${RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} -${RADIUS} ` +
    `H${tw - RADIUS} a${RADIUS} ${RADIUS} 0 0 1 ${RADIUS} ${RADIUS} V${BAR} Z`;
  const chrome =
    `<g class="f ${frame.cls}" transform="translate(${dx},${dy})">` +
    `<path d="${barPath}" fill="#161b22"/>` +
    `<line x1="0" y1="${BAR}" x2="${tw}" y2="${BAR}" stroke="#21262d" stroke-width="1"/>` +
    `<circle cx="19" cy="17" r="6" fill="#ff5f56"/>` +
    `<circle cx="39" cy="17" r="6" fill="#febc2e"/>` +
    `<circle cx="59" cy="17" r="6" fill="#28c840"/>` +
    `<text x="${Math.round(tw / 2)}" y="22" text-anchor="middle" fill="#7d8590" ` +
    `font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="12">${title}</text>` +
    `<rect x="0.5" y="0.5" width="${tw - 1}" height="${winH - 1}" rx="${RADIUS}" ` +
    `fill="none" stroke="#30363d" stroke-width="1"/></g>`;

  let extras = chrome;

  // Lay the title card on top, fading out over the cast's lead-in and back in over
  // the loop seam (which hides the cast's restart). Keyed to the master loop length.
  if (typeof titleCard === 'string' && titleCard.length > 0) {
    const loopMs = masterLoopMs(out);
    const pct = (ms) => Math.min(100, Math.max(0, (ms / loopMs) * 100));
    const hold = pct(introMs);
    const gone = pct(introMs + fadeMs);
    const back = pct(loopMs - fadeMs);
    const keyframes =
      `@keyframes afm-title{0%{opacity:1}${fmt(hold)}%{opacity:1}` +
      `${fmt(gone)}%{opacity:0}${fmt(back)}%{opacity:0}100%{opacity:1}}`;
    out = out.replace('</style>', `${keyframes}</style>`);
    extras +=
      `<g style="animation:afm-title ${fmt(loopMs / 1000)}s infinite ease-in-out">${titleCard}</g>`;
  }

  // Insert before the ROOT </svg> — the cast is a nested <svg>, so target the last.
  const i = out.lastIndexOf('</svg>');
  return out.slice(0, i) + extras + out.slice(i);
}

/** Read the master loop length (ms) from the composed SVG's frame-fade animation. */
function masterLoopMs(svg) {
  const m = /animation:\s*fv-\d+\s+([0-9.]+)s/.exec(svg);
  if (m === null) throw new Error('window: could not read the master loop length');
  return Math.round(Number(m[1]) * 1000);
}

/** Trim trailing zeros so percentages/seconds stay compact. */
const fmt = (n) => Number(n.toFixed(3)).toString();

export const WINDOW_BAR = BAR;
