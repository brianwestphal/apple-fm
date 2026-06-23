/**
 * Unit tests for the `web` built-in tool (FR-14 / AF-5 phase 4). The fetch
 * implementation is injected (a stub built on the real `Response`), so no network
 * is touched and the suite stays device-free.
 */
import { describe, expect, it, vi } from 'vitest';

import { fetchUrl } from '../src/tools/builtin/web.js';
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

  it('caps a very large body', async () => {
    const out = await fetchUrl('https://example.com/big', {
      fetchImpl: stubFetch('x'.repeat(50_000), { headers: { 'content-type': 'text/plain' } }),
    });
    expect(out).toMatch(/more chars truncated/);
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
});
