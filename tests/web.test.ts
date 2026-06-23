/**
 * Unit tests for the `web` built-in tool (FR-14 / AF-5 phase 4). The fetch
 * implementation is injected (a stub built on the real `Response`), so no network
 * is touched and the suite stays device-free.
 */
import { describe, expect, it, vi } from 'vitest';

import { fetchUrl, WEB_MAX_CHARS_ENV } from '../src/tools/builtin/web.js';
import { webTool } from '../src/tools/index.js';

/** A fetch stub that resolves a `Response` for any URL. */
function stubFetch(body: string, init?: ResponseInit): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(body, init)));
}

describe('web tool', () => {
  it('strips HTML to readable text', async () => {
    const html = '<html><head><style>.x{}</style></head><body>Hello <b>world</b> &amp; more<script>evil()</script></body></html>';
    const out = await fetchUrl('https://example.com', {
      fetchImpl: stubFetch(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    });
    expect(out).toMatch(/HTTP 200/);
    expect(out).toContain('Hello world & more');
    expect(out).not.toContain('evil');
    expect(out).not.toContain('<b>');
  });

  it('returns non-HTML content as-is', async () => {
    const json = '{"ok":true}';
    const out = await fetchUrl('https://api.example.com/x', {
      fetchImpl: stubFetch(json, { headers: { 'content-type': 'application/json' } }),
    });
    expect(out).toContain(json);
    expect(out).toMatch(/\(application\/json\)/);
  });

  it('reports a non-2xx HTTP status (not thrown)', async () => {
    const out = await fetchUrl('https://example.com/missing', {
      fetchImpl: stubFetch('nope', { status: 404, statusText: 'Not Found' }),
    });
    expect(out).toMatch(/HTTP 404 Not Found/);
  });

  it('caps a very large body and tells the model how to page', async () => {
    const out = await fetchUrl('https://example.com/big', {
      fetchImpl: stubFetch('x'.repeat(50_000), { headers: { 'content-type': 'text/plain' } }),
    });
    expect(out).toMatch(/more chars; call again with offset=3000 to continue/);
    expect(out.length).toBeLessThan(20_000);
  });

  it('rejects a non-http(s) URL without fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(fetchUrl('file:///etc/passwd', { fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toThrow(
      /must be an http\(s\) URL/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out a slow request', async () => {
    const hanging: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    await expect(fetchUrl('https://slow.example.com', { fetchImpl: hanging, timeoutMs: 50 })).rejects.toThrow(
      /timed out/,
    );
  });

  it('propagates a transport error', async () => {
    const failing: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(fetchUrl('https://down.example.com', { fetchImpl: failing })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('exposes a URL-scoped permission key + description', () => {
    expect(webTool.permissionKey?.({ url: 'https://example.com' })).toBe('https://example.com');
    expect(webTool.permissionKey?.({})).toBeUndefined();
    expect(webTool.describe?.({ url: 'https://example.com' })).toBe('fetch https://example.com');
    expect(webTool.describe?.({})).toBe('fetch (no url)');
  });

  const htmlInit: ResponseInit = { headers: { 'content-type': 'text/html; charset=utf-8' } };

  it('keeps the article body and drops nav/footer chrome (readability)', async () => {
    const page =
      '<html><body>' +
      '<nav><a href="/a">Home</a> <a href="/b">Products</a> <a href="/c">About</a></nav>' +
      '<header><a href="/login">Sign in</a></header>' +
      '<main><h1>Real Title</h1>' +
      '<p>This is the genuine article body with several real sentences of content that the model should actually read and summarize.</p>' +
      '</main>' +
      '<footer><a href="/x">Privacy</a> <a href="/y">Terms</a> &copy; 2026</footer>' +
      '</body></html>';
    const out = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit) });
    expect(out).toContain('Real Title');
    expect(out).toContain('genuine article body');
    expect(out).not.toContain('Products');
    expect(out).not.toContain('Privacy');
    expect(out).not.toContain('Sign in');
  });

  it('scopes to <article> when there is no <main>', async () => {
    const page =
      '<html><body><aside>Related: <a href="/r">other story</a></aside>' +
      '<article><p>The single relevant paragraph of the story goes here with enough length to count as content.</p></article>' +
      '</body></html>';
    const out = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit) });
    expect(out).toContain('single relevant paragraph');
    expect(out).not.toContain('other story');
  });

  it('drops a short link-list "paragraph" but keeps real prose', async () => {
    const page =
      '<html><body><main>' +
      '<p><a href="/1">One</a> <a href="/2">Two</a> <a href="/3">Three</a></p>' +
      '<p>A substantive paragraph of prose that easily clears the length threshold and is mostly plain text rather than links.</p>' +
      '</main></body></html>';
    const out = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit) });
    expect(out).toContain('substantive paragraph of prose');
    expect(out).not.toMatch(/One Two Three/);
  });

  it('falls back to a plain strip when there is no <p>/heading markup', async () => {
    const page = '<html><body><div>Hello <b>world</b> &amp; more</div></body></html>';
    const out = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit) });
    expect(out).toContain('Hello world & more');
  });

  it('pages into the extracted text with an offset', async () => {
    const para = 'ABCDEFGHIJ'.repeat(50); // 500 chars of prose-like content
    const page = `<html><body><main><p>${para}</p></main></body></html>`;
    const full = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit) });
    expect(full).toContain(para);
    const paged = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit), offset: 100 });
    expect(paged).toMatch(/\[from char 100\]/);
    expect(paged).toContain(para.slice(100));
    expect(paged).not.toContain(para); // the first 100 chars are skipped
  });

  it('honors a per-fetch maxChars cap (configurable window)', async () => {
    const para = 'word '.repeat(400); // ~2000 chars of content
    const page = `<html><body><main><p>${para}</p></main></body></html>`;
    const out = await fetchUrl('https://example.com', { fetchImpl: stubFetch(page, htmlInit), maxChars: 100 });
    expect(out).toMatch(/more chars; call again with offset=100 to continue/);
  });

  it('reads the cap from APPLE_FM_WEB_MAX_CHARS for the tool run', async () => {
    vi.stubEnv(WEB_MAX_CHARS_ENV, '50');
    try {
      const para = 'word '.repeat(400);
      const page = `<html><body><main><p>${para}</p></main></body></html>`;
      vi.stubGlobal('fetch', stubFetch(page, htmlInit));
      const out = await webTool.run({ url: 'https://example.com' }, {});
      expect(out).toMatch(/call again with offset=50 to continue/);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
