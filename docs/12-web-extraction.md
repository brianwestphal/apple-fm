# 12. Web Content Extraction

Requirements for how the `web` built-in tool turns a fetched page into the text
handed to the on-device model (FR-14 / AF-5; AFM-39). The tool's fetch/network
contract is in [11-builtin-tools.md](11-builtin-tools.md) (the `web` row + WT-1…4);
this doc is the *extraction* view — how HTML is reduced, paged, and capped so the
small (~4096-token) on-device window gets mostly real content.

> **Status:** Shipped (AFM-39; clean page boundaries WX-8 in AFM-40). Dependency-free,
> in `src/tools/builtin/web.ts` (`htmlToText`, `windowText`, `cleanCut`). Unit-tested in
> `tests/web.test.ts`.

## Why

The model's window is tiny and a tool result is fed back into it mid-turn, so a
page's text is capped (`MAX_TOOL_OUTPUT_CHARS`, 3 000 chars ≈ 750 tokens). Before
AFM-39 the HTML→text step was a flat tag-strip that kept nav menus, related-links,
cookie banners, and footers, so on a content-heavy page (Wikipedia, news) the cap
filled with boilerplate and the model saw little of the actual article — web reading
was slow and unreliable even though the plumbing (AFM-38) was correct. AFM-38 fixed
the crashes; AFM-39 makes the captured text mostly signal.

## Requirements

- **WX-1 Boilerplate removal.** Before anything else, drop the elements that never
  carry article content together with their contents: HTML comments, `<script>`,
  `<style>`, and the structural chrome `nav` / `header` / `footer` / `aside` / `form`
  / `noscript` / `svg` / `button` / `select` / `iframe` / `template` / `dialog`.
- **WX-2 Main-content scoping.** When the page marks up a main region, restrict
  extraction to the inner HTML of the first `<main>` (else the first `<article>`).
  This drops the entire page chrome on well-structured sites in one step.
- **WX-3 Content-block extraction.** Within the scope, keep the text of the real
  content blocks — headings (`<h1>`…`<h6>`), paragraphs (`<p>`), and preformatted
  code (`<pre>`) — in document order. These tags don't nest each other, so no text is
  double-counted.
- **WX-4 Link-density filter.** A short content block whose text is mostly anchor
  text (a menu / related-links remnant that slipped through WX-1/2) is dropped:
  `text.length < 200 && linkText.length > text.length * 0.5`.
- **WX-5 Safe fallback.** The heuristic must never gut an unusual page. When the
  extracted text is empty or captures less than 25 % of the scope's plain text (a page
  with no `<p>`/heading markup, or content the heuristic missed), fall back to a plain
  tag-strip of the scope. So the result is always ≥ what the old flat strip produced.
- **WX-6 Paging.** The model can page a long page with a 0-based character `offset`
  argument (mirrors `read`'s `offset`/`limit`). When the returned window is truncated,
  the result ends with `…(N more chars; call again with offset=<next> to continue)` so
  the model knows the page didn't end and how to continue. The status line notes
  `[from char <offset>]` when paging. The model never computes an offset itself — it
  copies the `<next>` value from the hint, so pages always tile with no gap or overlap.
- **WX-7 Configurable cap.** The per-fetch character cap defaults to
  `MAX_TOOL_OUTPUT_CHARS` but a user on a machine with a larger window can widen it via
  the `APPLE_FM_WEB_MAX_CHARS` environment variable (a positive integer; ignored
  otherwise). This is a **user** setting, not a model argument — the model can't widen
  its own window, only page within the configured one.
- **WX-8 Clean page boundaries.** A page never splits mid-word. `windowText` snaps the
  cut to the nearest **paragraph break** (`\n\n`), else a **line break**, else a **word
  boundary** (space), as long as that boundary lands in the second half of the window
  (so a page isn't shrunk too far); otherwise it cuts hard at the cap. The reported
  `<next>` offset is that boundary. A single token longer than the cap falls back to the
  hard cut, so paging always makes progress. Trailing whitespace on a page is trimmed
  for display (the offset math is unaffected). Works for HTML-extracted text and raw
  text/JSON alike — one unified character-offset scheme (AFM-40).

## Non-goals / limits

- Not a full DOM parse. This is a regex heuristic, kept dependency-free (NFR-4); it
  trades some fidelity (deeply nested or `<div>`-only "paragraph" layouts, content in
  `<li>`/`<table>`) for zero dependencies and predictability. WX-5 guarantees a floor.
- Not a renderer. JS-rendered SPAs that ship an empty shell still return little —
  the tool fetches static HTML only (WT-2).
- Extraction quality on the real model is still bounded by the tiny window; see the
  "On-device reality" note in [11-builtin-tools.md](11-builtin-tools.md).

## Follow-ups

- A `web` **search** backend remains a separate follow-up (TC-9 in
  [9-tool-calling.md](9-tool-calling.md)).

## Testing

`tests/web.test.ts` (device-free, injected `fetch`): article-body kept while
nav/header/footer dropped (WX-1/2), `<article>` scoping without `<main>` (WX-2),
link-list paragraph dropped (WX-4), plain-strip fallback for `<div>`-only markup
(WX-5), `offset` paging (WX-6), per-fetch `maxChars` cap and the
`APPLE_FM_WEB_MAX_CHARS` env var (WX-7), clean paragraph/word-boundary cuts and the
longer-than-cap hard-cut fallback (WX-8).
