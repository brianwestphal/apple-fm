import { describe, expect, it } from 'vitest';

import {
  encodeRequest,
  estimateConversationTokens,
  estimateTokens,
  flattenMessages,
  parseEvent,
  splitLines,
} from '../src/protocol.js';

describe('encodeRequest', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    const line = encodeRequest({ prompt: 'hi', stream: true });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({ prompt: 'hi', stream: true });
  });
});

describe('splitLines', () => {
  it('returns complete lines and carries the unterminated remainder', () => {
    const { lines, rest } = splitLines('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it('skips blank lines and returns empty rest when fully terminated', () => {
    const { lines, rest } = splitLines('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('');
  });
});

describe('parseEvent', () => {
  it('parses each event shape', () => {
    expect(parseEvent('{"type":"delta","text":"x"}')).toEqual({ type: 'delta', text: 'x' });
    expect(parseEvent('{"type":"result","content":"done"}')).toEqual({ type: 'result', content: 'done' });
    expect(parseEvent('{"type":"error","code":"e","message":"m"}')).toEqual({
      type: 'error',
      code: 'e',
      message: 'm',
    });
  });

  it('throws on unknown or malformed events', () => {
    expect(() => parseEvent('{"type":"nope"}')).toThrow(/malformed/);
    expect(() => parseEvent('{"type":"delta"}')).toThrow(/malformed/);
    expect(() => parseEvent('42')).toThrow(/malformed/);
  });
});

describe('flattenMessages', () => {
  // Pins the canonical labeled-turn format. The Swift helper's userPrompt and
  // session.ts:compact must produce this same shape — changing it here is a
  // signal to update both mirrors.
  it('labels turns and joins with blank lines', () => {
    const text = flattenMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(text).toBe('User: a\n\nAssistant: b');
  });
});

describe('token estimation', () => {
  it('estimates ~4 chars per token, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('sums the system prompt and all turns', () => {
    const total = estimateConversationTokens('abcd', [
      { role: 'user', content: 'abcd' },
      { role: 'assistant', content: 'abcd' },
    ]);
    expect(total).toBe(3);
  });
});
