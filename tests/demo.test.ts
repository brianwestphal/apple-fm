/**
 * Behavioral tests for the chat demo's frame spec (`scripts/demo.mjs`).
 *
 * The SVG is rendered from Apple's on-device model + headless Chromium and can't
 * run in CI, but the *animation logic* — what each frame types, how frames
 * transition, and what each frame commits — is pure and is exactly where AFM-8's
 * bugs lived. These tests pin that logic so it can't silently regress:
 *   1. every typed line (command + each prompt) shows a caret while typing;
 *   2. terminal frames hard-`cut` (no crossfade) so the committed transcript never
 *      dips the whole canvas — only the intro/loop are crossfades;
 *   3. content appears committed (no opacity "reveal" animations, which domotion
 *      drops on capture) — each turn is a type frame then a show frame;
 *   4. after `/quit` the demo returns to a blinking `$` shell prompt.
 */
import { describe, expect, it } from 'vitest';

import { buildChatFrames, parseChatTranscript } from '../scripts/demo.mjs';

interface Overlay {
  kind: string;
  caret?: boolean;
  anchor?: { selector: string; dy?: number };
}
interface Frame {
  input: string;
  duration: number;
  transition: { type: string; duration: number };
  overlays?: Overlay[];
  animations?: unknown[];
}
interface Spec {
  height: number;
  frames: Frame[];
  htmls: Record<string, string>;
}
interface Transcript {
  welcomeLines: string[];
  turns: { input: string; replyLines: string[] }[];
}

const demo = {
  slug: 'chat',
  title: { eyebrow: 'Chat', headline: 'Multi-turn', subtitle: 'auto-compacted' },
};

const data = {
  welcomeLines: ['apple-fm chat — Ctrl-D or /quit to quit, /help for commands.'],
  turns: [
    { input: 'Give me a two-word tagline.', replyLines: ['Edge Genius'] },
    { input: '/help', replyLines: ['Commands:', '  /quit  Quit'] },
    { input: '/quit', replyLines: [] },
  ],
};

const build = (turns = data.turns): Spec => buildChatFrames(demo, { ...data, turns });
const parse = (raw: string, turns: { input: string }[]): Transcript =>
  parseChatTranscript(raw, turns);

const typingOverlays = (frames: Frame[]): Overlay[] =>
  frames.flatMap((f) => (f.overlays ?? []).filter((o) => o.kind === 'typing'));
const htmlOf = ({ htmls }: Spec, input: string): string => htmls[input]!;

describe('buildChatFrames', () => {
  it('types the command then one prompt per turn, each with a caret (AFM-8: missing cursor)', () => {
    const typing = typingOverlays(build().frames);
    // shell command + one per turn (incl. /quit).
    expect(typing.length).toBe(1 + data.turns.length);
    expect(typing.every((o) => o.caret === true)).toBe(true);
    // Each typed line is nudged onto the committed-text baseline so it aligns with
    // its `$` / `>` (and with the committed copy it cuts to).
    expect(typing.every((o) => o.anchor?.dy === 4)).toBe(true);
  });

  it('crossfades only the intro and the loop; every terminal frame cuts (AFM-8: fade flicker)', () => {
    const { frames } = build();
    // First frame is the title card, which crossfades into the terminal; the last
    // frame crossfades back to the title so the loop is graceful.
    expect(frames[0]!.transition.type).toBe('crossfade');
    expect(frames[frames.length - 1]!.transition.type).toBe('crossfade');
    // Everything in between hard-cuts — no whole-canvas crossfade dip mid-session.
    for (const f of frames.slice(1, -1)) expect(f.transition.type).toBe('cut');
  });

  it('commits content instead of fading it in (domotion drops transparent reveals)', () => {
    // No frame relies on an opacity "reveal" animation — they do not play back.
    for (const f of build().frames) expect(f.animations ?? []).toEqual([]);
  });

  it('gives each turn a type frame then a show frame that commits the prompt + reply', () => {
    const spec = build();
    // Turn 0: the type frame shows the bare prompt (an empty `.cin` to type into)
    // and not yet the reply; the show frame commits the prompt text and the reply.
    const typed = htmlOf(spec, 'type0.html');
    expect(typed).toContain('class="cin"');
    expect(typed).not.toContain('Give me a two-word tagline.');
    expect(typed).not.toContain('Edge Genius');

    const shown = htmlOf(spec, 'show0.html');
    expect(shown).toContain('Give me a two-word tagline.');
    expect(shown).toContain('Edge Genius');
    expect(shown).not.toContain('class="cin"'); // prompt is committed, not typed
  });

  it('returns to a blinking shell prompt after /quit (AFM-8: quit feedback)', () => {
    const spec = build();
    const { frames } = spec;
    const exit = frames[frames.length - 1]!;
    const exitHtml = htmlOf(spec, exit.input);

    // The final show frame keeps the whole transcript (incl. the committed /quit)
    // and adds a fresh `$` shell line whose `.shellcur` anchors a cursor.
    expect(exitHtml).toContain('/quit');
    expect(exitHtml).toContain('shellcur');

    // A blinking block cursor sits on that shell prompt.
    const blink = (exit.overlays ?? []).find((o) => o.kind === 'blink');
    expect(blink).toMatchObject({ anchor: { selector: '.shellcur' } });
  });

  it('sizes the canvas to include the returned shell prompt line', () => {
    // Dropping a turn shrinks the canvas, confirming line counting is real.
    expect(build().height).toBeGreaterThan(build(data.turns.slice(0, 2)).height);
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
    // The whole /help block stays together — the `> ` inside `<text>` must not split it.
    expect(out[1]!.replyLines).toEqual([
      'Commands:',
      '  /reset [system]   Start over',
      '  /system <text>    Replace the system instructions',
      '  /quit             Quit',
    ]);
    // /quit prints nothing.
    expect(out[2]!.replyLines).toEqual([]);
  });
});
