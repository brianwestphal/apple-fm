/**
 * The `web` built-in tool (FR-14 / AF-5 phase 4): fetch an http(s) URL and return
 * its text content to the model.
 *
 * This is the **one** apple-fm tool that touches the network — so it is **off by
 * default**, opt-in (`chat --tools web`), and gated by the permission policy like
 * any other tool (its `permissionKey` is the URL, so a user can pre-approve a site).
 * The *model* still runs fully on-device; only this explicitly-enabled tool reaches
 * out. See docs/11-builtin-tools.md, docs/12-web-extraction.md, and NFR-1 in
 * docs/3-requirements.md.
 *
 * Dependency-free: uses Node's global `fetch` (Node ≥ 18). GET only, timeout-bounded.
 * HTML is reduced to its main article body (a readability-style heuristic, AFM-39) so
 * the small on-device window isn't filled with nav/boilerplate, then a window of the
 * text is returned: the model can page with `offset` and the user can widen the cap
 * with `APPLE_FM_WEB_MAX_CHARS`. A real *search* backend is a separate follow-up.
 */
import { MAX_TOOL_OUTPUT_CHARS } from '../output.js';
import type { Tool } from '../types.js';

/** Abort a request that takes longer than this (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Env var letting a user widen the per-fetch output cap (machines with a larger window). */
export const WEB_MAX_CHARS_ENV = 'APPLE_FM_WEB_MAX_CHARS';

/** Options for {@link fetchUrl} (exposed so tests can inject `fetch` / shorten the timeout). */
export interface FetchOptions {
  timeoutMs?: number;
  /** Override the fetch implementation (tests pass a stub; defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** 0-based character offset into the extracted text — lets the model page a long page. */
  offset?: number;
  /** Max characters of body text to return (user-configurable cap; defaults to the shared cap). */
  maxChars?: number;
}

/** Decode the handful of HTML entities a plain strip would otherwise leave raw. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** Strip all tags from an HTML fragment and collapse whitespace to plain text. */
function plain(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove the elements that never carry article content (scripts, styles, comments,
 * and the structural chrome: nav/header/footer/aside/form/etc.) along with their
 * contents, so neither the scope pick nor the fallback strip sees them.
 */
function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(
      /<(nav|header|footer|aside|form|noscript|svg|button|select|iframe|template|dialog)\b[^>]*>[\s\S]*?<\/\1>/gi,
      ' ',
    );
}

/** The inner HTML of the first `<main>` (then `<article>`), if the page marks one up. */
function mainScope(html: string): string | undefined {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (main?.[1] !== undefined) return main[1];
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  return article?.[1];
}

/**
 * Pull the real content blocks (headings, paragraphs, preformatted code) out of an
 * HTML scope in document order. These tags don't nest each other, so there's no
 * double-counting. A short block that's mostly anchor text is a nav/link-list remnant
 * and is dropped (link-density filter).
 */
function extractBlocks(html: string): string {
  const parts: string[] = [];
  const re = /<(h[1-6]|p|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const inner = match[2] ?? '';
    const text = plain(inner);
    if (text.length === 0) continue;
    const linkText = plain((inner.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []).join(' '));
    // Short and mostly links ⇒ a menu/related-links remnant, not prose.
    if (text.length < 200 && linkText.length > text.length * 0.5) continue;
    parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Reduce HTML to its main readable text (readability-style, dependency-free; AFM-39):
 * drop boilerplate, scope to `<main>`/`<article>` when present, then keep the content
 * blocks. Falls back to a plain strip of the scope when the heuristic captures too
 * little (an unusual page with no `<p>`/heading markup) so nothing is ever gutted.
 */
function htmlToText(html: string): string {
  const cleaned = stripBoilerplate(html);
  const scope = mainScope(cleaned) ?? cleaned;
  const extracted = extractBlocks(scope);
  const full = plain(scope);
  // Trust the extraction when it captured a meaningful share of the scope's text;
  // otherwise (no <p>/heading markup, or content the heuristic missed) fall back to a
  // plain strip so an unusual page is never gutted.
  if (extracted.length > 0 && extracted.length >= full.length * 0.25) return extracted;
  return full;
}

/**
 * Choose where to cut a `max`-char window so the page ends on a clean boundary
 * instead of mid-word (WX-8). Prefer a paragraph break, then a line break, then a
 * word boundary — but only when it lands past `min` so a page isn't shrunk too far;
 * otherwise cut hard at `max`. The returned length is always in `(0, max]`, so paging
 * always makes progress (a single token longer than `max` falls back to the hard cut).
 */
function cleanCut(window: string, max: number, min: number): number {
  const para = window.lastIndexOf('\n\n');
  if (para >= min) return para + 2;
  const line = window.lastIndexOf('\n');
  if (line >= min) return line + 1;
  const space = window.lastIndexOf(' ');
  if (space >= min) return space + 1;
  return max;
}

/**
 * Return a `[offset, offset+n)` window of `text`, with a paging hint when more
 * remains so the model knows to call again with the exact next `offset` rather than
 * assume the page ended. The cut snaps to a clean paragraph/line/word boundary so a
 * page never splits mid-word (WX-8); the reported next offset is that boundary, so
 * pages tile with no gap or overlap. Mirrors how `read` pages a large file.
 */
function windowText(text: string, offset: number, max: number): string {
  const start = Math.min(Math.max(offset, 0), text.length);
  const slice = text.slice(start);
  if (slice.length <= max) return slice;
  const cut = cleanCut(slice.slice(0, max), max, Math.floor(max / 2));
  const remaining = text.length - (start + cut);
  return `${slice.slice(0, cut).trimEnd()}\n…(${String(remaining)} more chars; call again with offset=${String(start + cut)} to continue)`;
}

/**
 * GET `url` and resolve a status line plus its text body (HTML reduced to its main
 * readable content; other content types returned as-is), windowed to `offset`/`maxChars`.
 * Rejects on a non-http(s) URL, a timeout, or a network/transport error (the dispatcher
 * feeds the message back to the model). An HTTP error *status* (404, 500, …) is a normal
 * reported result.
 */
export async function fetchUrl(url: string, options: FetchOptions = {}): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('web: "url" must be an http(s) URL');
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const contentType = response.headers.get('content-type') ?? '';
    const raw = await response.text();
    const text = contentType.includes('html') ? htmlToText(raw) : raw;
    const kind = contentType.split(';')[0]?.trim();
    const offset = options.offset ?? 0;
    const max = options.maxChars ?? MAX_TOOL_OUTPUT_CHARS;
    const status = `HTTP ${String(response.status)} ${response.statusText}${kind !== undefined && kind.length > 0 ? ` (${kind})` : ''}${offset > 0 ? ` [from char ${String(offset)}]` : ''}`;
    // Window the page text so a large page can't overflow the small on-device window;
    // the model pages forward with `offset` and the user can widen `max` via env.
    return `${status}\n\n${windowText(text, offset, max)}`;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('web: request timed out', { cause: error });
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce a model-supplied argument to a non-negative integer, or `undefined`. */
function intArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The user-configured output cap from `APPLE_FM_WEB_MAX_CHARS`, if set to a positive int. */
function envMaxChars(): number | undefined {
  const raw = process.env[WEB_MAX_CHARS_ENV];
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export const webTool: Tool = {
  name: 'web',
  description:
    'Fetch an http(s) URL (GET) and return its main text content. Use to read a web ' +
    'page or API the user references. Long pages are returned in chunks: pass a 0-based ' +
    '"offset" to page forward when the result says more remains. Network access — off by ' +
    'default and permission-gated.',
  parameters: {
    type: 'object',
    description: 'Arguments for the web tool.',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
      offset: { type: 'integer', minimum: 0, description: 'Character offset into the page text, to page a long page.' },
    },
  },
  permissionKey: (args) => (typeof args.url === 'string' ? args.url : undefined),
  describe: (args) => `fetch ${typeof args.url === 'string' ? args.url : '(no url)'}`,
  usageHint: 'web — fetch an http(s) URL and return its text; use it for ANY URL or web page (never use bash for a URL).',
  run: (args) =>
    fetchUrl(typeof args.url === 'string' ? args.url : '', { offset: intArg(args.offset), maxChars: envMaxChars() }),
};
