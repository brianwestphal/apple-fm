#!/usr/bin/env node
/**
 * The `apple-fm` bin. Thin: parse args (cliArgs.ts), do I/O, delegate to the
 * library (helper.ts / session.ts / repl.ts).
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { parseArgs, USAGE } from './cliArgs.js';
import { generate, probe } from './helper.js';
import { runRepl } from './repl.js';
import type { GenerateOptions, GenerateRequest } from './types.js';

/** Read all of stdin as UTF-8 (used when `generate` is given no prompt arg). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function readVersion(): string {
  // package.json sits one level above dist/.
  try {
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'help':
      process.stdout.write(`${USAGE}\n`);
      return;
    case 'version':
      process.stdout.write(`${readVersion()}\n`);
      return;
    case 'probe': {
      const result = await probe();
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.available) process.exitCode = 1;
      return;
    }
    case 'generate': {
      const prompt = args.prompt ?? (await readStdin());
      if (prompt.length === 0) throw new Error('generate: no prompt given (pass an argument or pipe stdin)');
      const options: GenerateOptions = {};
      if (args.temperature !== undefined) options.temperature = args.temperature;
      if (args.maxTokens !== undefined) options.maxTokens = args.maxTokens;
      const request: GenerateRequest = { prompt, system: args.system, options, stream: args.stream };
      if (args.schemaFile !== undefined) request.schema = JSON.parse(await readFile(args.schemaFile, 'utf8'));
      const text = await generate(request, {}, args.stream ? (chunk) => process.stdout.write(chunk) : undefined);
      if (!args.stream) process.stdout.write(text);
      process.stdout.write('\n');
      return;
    }
    case 'chat': {
      await runRepl({ system: args.system, stream: args.stream, compactAtTokens: args.compactAtTokens });
      return;
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`apple-fm: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
