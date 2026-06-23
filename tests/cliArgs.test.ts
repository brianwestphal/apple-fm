import { describe, expect, it } from 'vitest';

import { parseArgs, USAGE } from '../src/cliArgs.js';

describe('parseArgs', () => {
  it('defaults to help with no args or -h/--help', () => {
    expect(parseArgs([])).toEqual({ command: 'help' });
    expect(parseArgs(['-h'])).toEqual({ command: 'help' });
    expect(parseArgs(['--help'])).toEqual({ command: 'help' });
  });

  it('parses version', () => {
    expect(parseArgs(['-v'])).toEqual({ command: 'version' });
    expect(parseArgs(['--version'])).toEqual({ command: 'version' });
  });

  it('parses probe', () => {
    expect(parseArgs(['probe'])).toEqual({ command: 'probe' });
  });

  it('parses generate with a prompt and flags', () => {
    expect(
      parseArgs(['generate', 'hello', '-s', 'be terse', '--stream', '--temp', '0.5', '--max-tokens', '128']),
    ).toEqual({
      command: 'generate',
      prompt: 'hello',
      system: 'be terse',
      stream: true,
      temperature: 0.5,
      maxTokens: 128,
    });
  });

  it('parses generate --schema', () => {
    const parsed = parseArgs(['generate', 'x', '--schema', 'shape.json']);
    expect(parsed).toMatchObject({ command: 'generate', prompt: 'x', schemaFile: 'shape.json', stream: false });
  });

  it('defaults generate stream to false and allows a stdin (no-prompt) form', () => {
    expect(parseArgs(['generate'])).toEqual({ command: 'generate', stream: false });
  });

  it('parses chat with streaming on by default and --no-stream / --compact-at', () => {
    expect(parseArgs(['chat'])).toEqual({ command: 'chat', stream: true });
    expect(parseArgs(['chat', '--no-stream', '--compact-at', '2000', '-s', 'hi'])).toEqual({
      command: 'chat',
      stream: false,
      compactAtTokens: 2000,
      system: 'hi',
    });
  });

  it('parses chat --tools into a trimmed, non-empty name list', () => {
    expect(parseArgs(['chat', '--tools', 'read'])).toEqual({ command: 'chat', stream: true, tools: ['read'] });
    expect(parseArgs(['chat', '--tools', ' read , bash ,'])).toEqual({
      command: 'chat',
      stream: true,
      tools: ['read', 'bash'],
    });
  });

  it('rejects unknown commands and flags', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(/unknown command/);
    expect(() => parseArgs(['generate', '--nope'])).toThrow(/unknown flag/);
    expect(() => parseArgs(['chat', '--nope'])).toThrow(/unknown flag/);
  });

  it('rejects a second positional prompt and missing flag values', () => {
    expect(() => parseArgs(['generate', 'a', 'b'])).toThrow(/single prompt/);
    expect(() => parseArgs(['generate', '--temp'])).toThrow(/requires a value/);
    expect(() => parseArgs(['generate', '--temp', 'abc'])).toThrow(/expects a number/);
  });

  it('exposes usage text', () => {
    expect(USAGE).toMatch(/apple-fm/);
    expect(USAGE).toMatch(/APPLE_FM_BIN/);
  });
});
