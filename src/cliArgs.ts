/**
 * Argument parsing for the `apple-fm` bin. Pure and testable: {@link parseArgs}
 * turns `argv` into a discriminated {@link ParsedArgs}; `cli.ts` does the I/O.
 */

import type { GenerateUseCase, ModelId } from './types.js';

/** The fully-parsed command line. */
export type ParsedArgs =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'probe' }
  | { command: 'tokens'; prompt?: string }
  | {
      command: 'generate';
      useCase?: GenerateUseCase;
      imagePath?: string;
      prompt?: string;
      model?: ModelId;
      system?: string;
      schemaFile?: string;
      stream: boolean;
      temperature?: number;
      maxTokens?: number;
    }
  | {
      command: 'chat';
      model?: ModelId;
      system?: string;
      stream: boolean;
      compactAtTokens?: number;
      tools?: string[];
      allowTools?: string[];
      denyTools?: string[];
      yes?: boolean;
    };

export const USAGE = `apple-fm — command-line access to Apple Foundation Models

Usage:
  apple-fm probe                       List models and their availability
  apple-fm tokens [text]               Count prompt tokens (macOS 26.4+, reads stdin if omitted)
  apple-fm generate [prompt] [flags]   One-shot generation (reads stdin if no prompt)
  apple-fm chat [flags]                Interactive chat (streaming, auto-compaction)

Generate flags:
      --image <file>     Include a local image in the prompt (macOS 27+)
      --use-case <name>  general (default) or content-tagging (JSON array)
                         Content tagging cannot use --stream or --schema
      --model <id>       Model ID from probe (default: on-device)
  -s, --system <text>     System instructions
      --schema <file>     JSON Schema file for guided/structured output
      --stream            Stream output as it is produced
      --temp <n>          Sampling temperature
      --max-tokens <n>    Maximum response tokens

Chat flags:
      --model <id>       Model ID from probe (default: on-device)
  -s, --system <text>     System instructions
      --no-stream         Disable token streaming
      --compact-at <n>    Compact the transcript past <n> estimated tokens
      --tools <a,b>       Enable built-in tools the model may call (read, bash)
      --allow-tool <rule> Pre-approve a tool (read, read:/path, or bash:<exact cmd>).
                          A read path grant covers that dir; a bash grant is the
                          EXACT command only. Repeatable
      --deny-tool <rule>  Deny a tool (same syntax; a bash deny is best-effort).
                          Repeatable
      --yes               Auto-approve tool calls — except bash, which still prompts
                          (add --allow-tool bash to include it). Use with care

Global:
  -h, --help              Show this help
  -v, --version           Show version

The helper binary is found via APPLE_FM_BIN (an explicit override, trusted as-is),
otherwise the bundled bin/apple-fm-helper shipped with the package. Requires macOS
26+ on Apple Silicon with Apple Intelligence enabled.`;

/** Parse a numeric flag value, throwing a clear error on garbage. */
function parseNumber(flag: string, value: string | undefined): number {
  if (value === undefined) throw new Error(`${flag} requires a value`);
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`${flag} expects a number, got "${value}"`);
  return n;
}

/** Read the value that follows a flag at `argv[i]`, advancing past it. */
function takeValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

/**
 * Parse `argv` (without the leading `node`/script entries) into a
 * {@link ParsedArgs}. Throws on unknown commands or flags.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const first = argv[0];
  if (first === undefined || first === '-h' || first === '--help') return { command: 'help' };
  if (first === '-v' || first === '--version') return { command: 'version' };

  switch (first) {
    case 'probe':
      return { command: 'probe' };
    case 'tokens': {
      const [, prompt, extra] = argv;
      if (extra !== undefined) throw new Error('tokens accepts a single text argument');
      return { command: 'tokens', prompt };
    }
    case 'generate':
      return parseGenerate(argv.slice(1));
    case 'chat':
      return parseChat(argv.slice(1));
    default:
      throw new Error(`unknown command "${first}" (try: probe, tokens, generate, chat, --help)`);
  }
}

function parseModel(value: string | undefined): ModelId {
  if (value === undefined || value.startsWith('-')) throw new Error('--model requires a value');
  if (value === 'on-device') return value;
  throw new Error(`unknown model "${value}" (run apple-fm probe)`);
}

function parseUseCase(value: string | undefined): GenerateUseCase {
  if (value === undefined || value.startsWith('-')) throw new Error('--use-case requires a value');
  if (value === 'general' || value === 'content-tagging') return value;
  throw new Error(`unknown use case "${value}" (choose general or content-tagging)`);
}

function parseGenerate(argv: string[]): ParsedArgs {
  const result: Extract<ParsedArgs, { command: 'generate' }> = { command: 'generate', stream: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--image':
        result.imagePath = takeValue(argv, i++, arg);
        if (result.imagePath.length === 0 || result.imagePath.startsWith('--')) {
          throw new Error('--image requires a file path');
        }
        break;
      case '--use-case':
        result.useCase = parseUseCase(argv[++i]);
        break;
      case '--model':
        result.model = parseModel(argv[++i]);
        break;
      case '-s':
      case '--system':
        result.system = takeValue(argv, i++, arg);
        break;
      case '--schema':
        result.schemaFile = takeValue(argv, i++, arg);
        break;
      case '--stream':
        result.stream = true;
        break;
      case '--temp':
        result.temperature = parseNumber(arg, takeValue(argv, i++, arg));
        break;
      case '--max-tokens':
        result.maxTokens = parseNumber(arg, takeValue(argv, i++, arg));
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`unknown flag "${arg}"`);
        if (result.prompt !== undefined) throw new Error('generate accepts a single prompt argument');
        result.prompt = arg;
    }
  }
  if (result.useCase === 'content-tagging' && (result.stream || result.schemaFile !== undefined)) {
    throw new Error('content-tagging cannot be combined with --stream or --schema');
  }
  if (result.useCase === 'content-tagging' && result.imagePath !== undefined) {
    throw new Error('--image requires the general use case');
  }
  return result;
}

function parseChat(argv: string[]): ParsedArgs {
  const result: Extract<ParsedArgs, { command: 'chat' }> = { command: 'chat', stream: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--model':
        result.model = parseModel(argv[++i]);
        break;
      case '-s':
      case '--system':
        result.system = takeValue(argv, i++, arg);
        break;
      case '--no-stream':
        result.stream = false;
        break;
      case '--compact-at':
        result.compactAtTokens = parseNumber(arg, takeValue(argv, i++, arg));
        break;
      case '--tools':
        result.tools = parseList(takeValue(argv, i++, arg));
        break;
      case '--allow-tool':
        (result.allowTools ??= []).push(takeValue(argv, i++, arg));
        break;
      case '--deny-tool':
        (result.denyTools ??= []).push(takeValue(argv, i++, arg));
        break;
      case '--yes':
        result.yes = true;
        break;
      default:
        throw new Error(`unknown flag "${arg}"`);
    }
  }
  return result;
}

/** Split a comma-separated flag value into trimmed, non-empty names. */
function parseList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}
