/**
 * The title card laid over each demo's opening beat.
 *
 * Each demo is a single terminal `cast` (see cast.mjs) dressed as a window
 * (window.mjs); the title card is SVG markup that window.mjs layers on top and
 * fades out over the cast's lead-in. We emit SVG directly (rather than capturing
 * HTML) so it composes into the demo with no id collisions and no font-glyph
 * duplication.
 *
 * The card is a centered dark panel mirroring the terminal window's surface, so
 * the two read as one family. Being its own dark panel, the card's text stays
 * legible on any README background, light or dark.
 */

/** Shared canvas width for every demo SVG (px). */
export const WIDTH = 880;

const CARD_W = 660;
const PAD = 44; // card inner padding
const EYEBROW_H = 14;
const HEAD_LH = 36; // headline line height
const SUB_LH = 23; // subtitle line height
const RULE_H = 3;
const GAP = 18;

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Greedy word-wrap to at most `width` characters per line. */
function wrapText(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length > 0 && (line + ' ' + word).length > width) {
      out.push(line);
      line = word;
    } else {
      line = line.length > 0 ? `${line} ${word}` : word;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,monospace';

/**
 * The title card as a self-contained SVG `<g>` for {@link decorateWindow} to layer
 * over the opening: an eyebrow, a headline, an accent rule, and a subtitle on a
 * centered dark card. `accent` tints the eyebrow and rule.
 */
export function titleCardSvg({
  eyebrow,
  headline,
  subtitle,
  accent = '#7ee787',
  canvasW,
  canvasH,
  coverW = 0,
  coverH = 0,
}) {
  const headLines = wrapText(headline, 24);
  const subLines = wrapText(subtitle, 52);

  const contentH =
    EYEBROW_H + GAP + headLines.length * HEAD_LH + GAP + RULE_H + GAP + subLines.length * SUB_LH;
  // The card must fully cover the terminal window behind it during the intro, so
  // grow it to the window's footprint (plus a margin) when that's larger.
  const cardW = Math.max(CARD_W, coverW + 60);
  const cardH = Math.max(contentH + 2 * PAD, coverH + 44);
  const cardX = Math.round((canvasW - cardW) / 2);
  const cardY = Math.round((canvasH - cardH) / 2);
  const cx = Math.round(canvasW / 2);

  // Vertically center the text block within the (possibly taller) card.
  let y = cardY + Math.round((cardH - contentH) / 2) + EYEBROW_H;
  const parts = [
    `<rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" ` +
      `fill="#0d1117" stroke="#30363d" stroke-width="1"/>`,
    `<text x="${cx}" y="${y}" text-anchor="middle" fill="${esc(accent)}" font-family="${MONO}" ` +
      `font-size="12" font-weight="600" letter-spacing="2.6">${esc(eyebrow.toUpperCase())}</text>`,
  ];

  y += GAP + 24;
  for (const line of headLines) {
    parts.push(
      `<text x="${cx}" y="${y}" text-anchor="middle" fill="#e6edf3" font-family="${SANS}" ` +
        `font-size="30" font-weight="700">${esc(line)}</text>`,
    );
    y += HEAD_LH;
  }

  y += GAP - HEAD_LH + 24;
  parts.push(
    `<rect x="${cx - 23}" y="${y}" width="46" height="${RULE_H}" rx="1.5" fill="${esc(accent)}"/>`,
  );

  y += RULE_H + GAP + 16;
  for (const line of subLines) {
    parts.push(
      `<text x="${cx}" y="${y}" text-anchor="middle" fill="#8b949e" font-family="${SANS}" ` +
        `font-size="15">${esc(line)}</text>`,
    );
    y += SUB_LH;
  }

  return `<g>${parts.join('')}</g>`;
}
