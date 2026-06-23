/**
 * The `web` built-in tool (FR-14 / AF-5 phase 4): fetch an http(s) URL and return
 * its text content to the model.
 *
 * This is the **one** apple-fm tool that touches the network — so it is **off by
 * default**, opt-in (`chat --tools web`), and gated by the permission policy like
 * any other tool (its `permissionKey` is the URL, so a user can pre-approve a site).
 * The *model* still runs fully on-device; only this explicitly-enabled tool reaches
 * out. See docs/11-builtin-tools.md and NFR-1 in docs/3-requirements.md.
 *
 * Dependency-free: uses Node's global `fetch` (Node ≥ 18). GET only, timeout-bounded,
 * and the returned text is capped so a large page can't blow the model's context
 * window. A real *search* backend (an external API/endpoint) is a separate follow-up.
 */
import type { Tool } from '../types.js';

/** Abort a request that takes longer than this (ms). */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Cap the returned text to this many characters. */
const MAX_TEXT_CHARS = 16_000;

/** Options for {@link fetchUrl} (exposed so tests can inject `fetch` / shorten the timeout). */
export interface FetchOptions {
  timeoutMs?: number;
  /** Override the fetch implementation (tests pass a stub; defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Strip HTML to readable text (dependency-free, best-effort). */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate text to the cap, noting how much was dropped. */
function cap(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_TEXT_CHARS)}\n…(${String(text.length - MAX_TEXT_CHARS)} more chars truncated)`;
}

/**
 * GET `url` and resolve a status line plus its text body (HTML stripped to text;
 * other content types returned as-is), capped. Rejects on a non-http(s) URL, a
 * timeout, or a network/transport error (the dispatcher feeds the message back to
 * the model). An HTTP error *status* (404, 500, …) is a normal reported result.
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
    const status = `HTTP ${String(response.status)} ${response.statusText}${kind !== undefined && kind.length > 0 ? ` (${kind})` : ''}`;
    return `${status}\n\n${cap(text)}`;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('web: request timed out', { cause: error });
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    clearTimeout(timer);
  }
}

export const webTool: Tool = {
  name: 'web',
  description:
    'Fetch an http(s) URL (GET) and return its text content. Use to read a web page ' +
    'or API the user references. Network access — off by default and permission-gated.',
  parameters: {
    type: 'object',
    description: 'Arguments for the web tool.',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch.' },
    },
  },
  permissionKey: (args) => (typeof args.url === 'string' ? args.url : undefined),
  describe: (args) => `fetch ${typeof args.url === 'string' ? args.url : '(no url)'}`,
  run: (args) => fetchUrl(typeof args.url === 'string' ? args.url : ''),
};
