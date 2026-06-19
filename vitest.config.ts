import { defineConfig } from 'vitest/config';

/**
 * Unit tests. Fast and isolated.
 *
 * The Swift helper and the process-spawning paths are exercised against a small
 * `node -e` stub command (see tests/helper.test.ts), so no macOS 26 device or
 * real on-device model is needed to run the suite.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // The bin dispatch (cli.ts) and the interactive readline loop (repl.ts) are
      // thin I/O wrappers; their logic lives in cliArgs/session/helper, which are
      // unit-tested directly.
      exclude: ['src/cli.ts', 'src/repl.ts'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
});
