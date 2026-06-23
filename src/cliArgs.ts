/**
 * Argument parsing for the `apple-fm` bin. Pure and testable: {@link parseArgs}
 * turns `argv` into a discriminated {@link ParsedArgs}; `cli.ts` does the I/O.
 */

/** The fully-parsed command line. */
export type ParsedArgs =
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'probe' }
  | {
      command: 'generate';
      prompt?: string;
      system?: string;
      schemaFile?: string;
      stream: boolean;
      temperature?: number;
      maxTokens?: number;
    }
  | {
      command: 'chat';
      system?: string;
      stream: boolean;
      compactAtTokens?: number;
      tools?: string[];
      allowTools?: string[];
      denyTools?: string[];
      yes?: boolean;
    };

export const USAGE = `apple-fm — command-line access to Apple's on-device Foundation Models

Usage:
  apple-fm probe                       Check on-device model availability
  apple-fm generate [prompt] [flags]   One-shot generation (reads stdin if no prompt)
  apple-fm chat [flags]                Interactive chat (streaming, auto-compaction)

Generate flags:
  -s, --system <text>     System instructions
      --schema <file>     JSON Schema file for guided/structured output
      --stream            Stream output as it is produced
      --temp <n>          Sampling temperature
      --max-tokens <n>    Maximum response tokens

Chat flags:
  -s, --system <text>     System instructions
      --no-stream         Disable token streaming
      --compact-at <n>    Compact the transcript past <n> estimated tokens
      --tools <a,b>       Enable built-in tools the model may call (read, bash)
      --allow-tool <rule> Pre-approve a tool (e.g. read, or read:/path). Repeatable
      --deny-tool <rule>  Always deny a tool (same syntax). Repeatable
      --yes               Auto-approve every tool call (use with care)

Global:
  -h, --help              Show this help
  -v, --version           Show version

The helper binary is found via APPLE_FM_BIN, then the bundled bin/apple-fm-helper,
then apple-fm-helper on PATH. Requires macOS 26+ on Apple Silicon with Apple
Intelligence enabled.`;

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
    case 'generate':
      return parseGenerate(argv.slice(1));
    case 'chat':
      return parseChat(argv.slice(1));
    default:
      throw new Error(`unknown command "${first}" (try: probe, generate, chat, --help)`);
  }
}

function parseGenerate(argv: string[]): ParsedArgs {
  const result: Extract<ParsedArgs, { command: 'generate' }> = { command: 'generate', stream: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
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
  return result;
}

function parseChat(argv: string[]): ParsedArgs {
  const result: Extract<ParsedArgs, { command: 'chat' }> = { command: 'chat', stream: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
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
