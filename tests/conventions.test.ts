/**
 * Convention guards that pin requirements line/branch coverage can't express
 * (surfaced by the feature-coverage exercise):
 *   - NFR-4: zero runtime dependencies.
 *   - NFR-1: the Node layer never imports a network/cloud SDK — only Node
 *     builtins (`node:*`) and relative modules.
 *   - FR-10: the public API exports exactly the documented surface (a dropped or
 *     renamed export fails here, not just in review).
 */
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as api from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
};

describe('project conventions', () => {
  it('declares zero runtime dependencies (NFR-4)', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it('src/ imports only Node builtins or relative modules — no network/cloud SDK (NFR-1)', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const offenders: string[] = [];
    const record = (file: string, spec: string | undefined): void => {
      if (spec === undefined || spec.startsWith('.') || spec.startsWith('node:')) return;
      offenders.push(`${file}: ${spec}`);
    };
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      // Strip comments first so a `from 'apple-fm'` inside a TSDoc @example is not
      // mistaken for a real import.
      const code = readFileSync(new URL(file, srcDir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of code.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) record(file, match[1]);
      for (const match of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) record(file, match[1]);
    }
    expect(offenders).toEqual([]);
  });

  it('exposes exactly the documented public API surface (FR-10)', () => {
    expect(Object.keys(api).sort()).toEqual([
      'BUILTIN_TOOLS',
      'ChatSession',
      'HELPER_BIN_ENV',
      'LiveSession',
      'PermissionPolicy',
      'ToolRegistry',
      'bashTool',
      'encodeRequest',
      'estimateConversationTokens',
      'estimateTokens',
      'flattenMessages',
      'generate',
      'isPlatformSupported',
      'parseEvent',
      'probe',
      'readTool',
      'registryFromNames',
      'resolveHelperPath',
      'splitLines',
      'toolGuidancePrompt',
      'webTool',
    ]);
  });
});
