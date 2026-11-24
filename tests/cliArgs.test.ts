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

  it('parses a text argument or stdin for tokens', () => {
    expect(parseArgs(['tokens', 'text'])).toEqual({ command: 'tokens', prompt: 'text' });
    expect(parseArgs(['tokens'])).toMatchObject({ command: 'tokens' });
    expect(() => parseArgs(['tokens', 'a', 'b'])).toThrow(/single text argument/);
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

  it.each(['generate', 'chat'])('parses and validates --model for %s', (command) => {
    expect(parseArgs([command, '--model', 'on-device'])).toMatchObject({ model: 'on-device' });
    expect(() => parseArgs([command, '--model', 'private-cloud-compute'])).toThrow(/unknown model.*probe/);
    expect(() => parseArgs([command, '--model', 'other'])).toThrow(/unknown model.*probe/);
    expect(() => parseArgs([command, '--model'])).toThrow(/requires a value/);
    expect(() => parseArgs([command, '--model', '--system'])).toThrow(/requires a value/);
  });

  it('parses general and content tagging for generate', () => {
    expect(parseArgs(['generate', '--use-case', 'content-tagging', 'Hello'])).toMatchObject({
      command: 'generate', prompt: 'Hello', useCase: 'content-tagging',
    });
    expect(parseArgs(['generate', '--use-case', 'general', '--stream'])).toMatchObject({
      useCase: 'general', stream: true,
    });
  });

  it('rejects missing or unknown use cases and tagging in chat', () => {
    expect(() => parseArgs(['generate', '--use-case'])).toThrow(/requires a value/);
    expect(() => parseArgs(['generate', '--use-case', '--stream'])).toThrow(/requires a value/);
    expect(() => parseArgs(['generate', '--use-case', 'other'])).toThrow(/unknown use case/);
    expect(() => parseArgs(['chat', '--use-case', 'content-tagging'])).toThrow(/unknown flag/);
  });

  it.each([{ flags: ['--stream'] }, { flags: ['--schema', 'shape.json'] }])(
    'rejects $flags with the content tagging use case',
    ({ flags }) => {
      expect(() => parseArgs(['generate', '--use-case', 'content-tagging', ...flags])).toThrow(/cannot be combined/);
    },
  );

  it('parses image input and rejects it in other use cases', () => {
    expect(parseArgs(['generate', '--image', 'photo.png', 'Describe it'])).toMatchObject({
      imagePath: 'photo.png', prompt: 'Describe it',
    });
    expect(() => parseArgs(['generate', '--image'])).toThrow(/requires a value/);
    expect(() => parseArgs(['generate', '--image', '--stream'])).toThrow(/requires a file path/);
    expect(() => parseArgs(['generate', '--image', 'photo.png', '--use-case', 'content-tagging']))
      .toThrow(/general use case/);
  });

  it('accepts greedy sampling and validates the flag', () => {
    expect(parseArgs(['generate', '--sampling', 'greedy', 'test'])).toMatchObject({ sampling: 'greedy' });
    expect(() => parseArgs(['generate', '--sampling', 'random'])).toThrow(/unknown sampling mode/);
    expect(() => parseArgs(['generate', '--sampling'])).toThrow(/requires a value/);
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

  it('parses chat permission flags (--allow-tool / --deny-tool repeatable, --yes)', () => {
    expect(
      parseArgs([
        'chat',
        '--tools',
        'read,bash',
        '--allow-tool',
        'read',
        '--allow-tool',
        'bash:git status',
        '--deny-tool',
        'bash:rm',
        '--yes',
      ]),
    ).toEqual({
      command: 'chat',
      stream: true,
      tools: ['read', 'bash'],
      allowTools: ['read', 'bash:git status'],
      denyTools: ['bash:rm'],
      yes: true,
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
