/**
 * Unit tests for the shared tool-output cap (FR-14 / AFM-38) — keeps a tool result
 * small enough for the on-device model's context window.
 */
import { describe, expect, it } from 'vitest';

import { capOutput, MAX_TOOL_OUTPUT_CHARS } from '../src/tools/output.js';

describe('capOutput', () => {
  it('returns text at or under the cap unchanged', () => {
    expect(capOutput('hello')).toBe('hello');
    expect(capOutput('x'.repeat(MAX_TOOL_OUTPUT_CHARS))).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
  });

  it('truncates oversized text and notes how much was dropped', () => {
    const out = capOutput('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 250));
    expect(out).toMatch(/250 more chars truncated/);
    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 100);
  });

  it('respects a custom max', () => {
    expect(capOutput('abcdef', 3)).toMatch(/^abc\n…\(3 more chars truncated\)$/);
  });

  it('keeps the cap well under a ~4k-token context window', () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBeLessThanOrEqual(8_000); // ~2k tokens, leaves room
  });
});
