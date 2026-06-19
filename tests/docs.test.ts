import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const srcFiles = readdirSync(new URL('../src', import.meta.url)).filter((f) => f.endsWith('.ts'));

describe('documentation stays in sync with src/', () => {
  const codeSummary = read('../docs/ai/code-summary.md');
  const claude = read('../docs/../CLAUDE.md');

  it.each(srcFiles)('code-summary.md references %s', (file) => {
    expect(codeSummary).toContain(file);
  });

  it('CLAUDE.md references every src module', () => {
    const missing = srcFiles.filter((f) => !claude.includes(f));
    expect(missing).toEqual([]);
  });

  it('the documented coverage thresholds match vitest.config.ts', () => {
    const vitest = read('../vitest.config.ts');
    for (const line of ['statements: 80', 'branches: 75', 'functions: 80', 'lines: 80']) {
      expect(vitest).toContain(line);
    }
    // CLAUDE.md states them in prose.
    expect(claude).toMatch(/statements 80, branches 75, functions 80, lines 80/);
  });

  it('every numbered doc is linked from CLAUDE.md', () => {
    const docs = readdirSync(new URL('../docs', import.meta.url)).filter((f) => /^\d+-.*\.md$/.test(f));
    const missing = docs.filter((f) => !claude.includes(f));
    expect(missing).toEqual([]);
  });

  it('root is resolvable (sanity)', () => {
    expect(root.endsWith('/')).toBe(true);
  });
});
