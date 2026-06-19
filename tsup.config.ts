import { defineConfig } from 'tsup';

/**
 * Library + CLI build.
 *
 * - `index` is the public programmatic API (probe / generate / chat sessions).
 * - `cli` is the `apple-fm` bin. Its source keeps a leading
 *   `#!/usr/bin/env node` shebang, which esbuild preserves on entry points, so
 *   no banner injection is needed.
 *
 * Zero runtime dependencies — the Node layer only spawns the Swift helper and
 * speaks line-delimited JSON to it, so nothing is bundled or marked external.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: 'esm',
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  splitting: false,
  clean: true,
  sourcemap: true,
  dts: true,
});
