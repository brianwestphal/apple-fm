---
name: analyze-code-quality
description: Run all available tests and linters, check for anti-patterns, and generate a comprehensive code quality report
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Analyze the overall quality of the apple-fm source. Generate a comprehensive
report.

## Steps

1. **Run unit tests with coverage**
   ```
   npm test
   ```
   Report total tests, pass/fail, and coverage per file. The thresholds in
   `vitest.config.ts` (statements 80 / branches 75 / functions 80 / lines 80) are
   the floor; flag any file that drags the suite under them. `cli.ts` and
   `repl.ts` are intentionally excluded (thin I/O) — confirm they have no
   testable logic that crept in.

2. **Run the linter**
   ```
   npm run lint
   ```
   Report errors/warnings grouped by rule.

3. **Run typecheck**
   ```
   npm run typecheck
   ```
   Report any type errors.

4. **Build the helper (best-effort)**
   ```
   npm run build:helper
   ```
   On a macOS 26 machine this should emit `bin/apple-fm-helper`. On other
   machines the script no-ops with exit 0 by design — note which happened. If it
   built, run `bin/apple-fm-helper --probe` and report the availability line.

5. **Check anti-patterns** (conventions from `CLAUDE.md`):
   - **Relative imports missing `.js`** — grep `src/`/`tests/` for relative
     imports without a `.js` suffix.
   - **`any` leaks** — grep `src/` for `: any\b`, `as any\b`, `<any>`. The house
     style is `unknown` + a narrowing check.
   - **Truthy string checks** — `strict-boolean-expressions` is on; flag any
     `if (someString)` style test (use `=== undefined` / `.length`).
   - **Runtime dependencies** — `package.json` `dependencies` must stay empty
     (the Node layer only spawns the helper). Flag any addition.
   - **Node imports the model directly** — only `apple-fm-helper/main.swift` may
     reference `FoundationModels`. Grep `src/` for `FoundationModels` (should be
     zero hits outside comments).
   - **Protocol drift** — `tests/fixtures/stub-helper.js` must still implement the
     same events as `docs/4-protocol.md` and the Swift helper.
   - **File length** — flag any `src/*.ts` over ~200 LOC; prefer splitting.

6. **Check the build shape**
   ```
   npm run build && ls dist/
   ```
   Verify `dist/index.js`, `dist/cli.js`, and their `.d.ts` files exist, and that
   `dist/cli.js` keeps its `#!/usr/bin/env node` shebang.

## Report Format

- **Summary**: tests pass/fail, coverage %, lint clean, typecheck clean, helper
  build outcome (built / skipped-by-guard).
- **Coverage**: per-file table, highlighting anything under threshold.
- **Lint / Type issues**: grouped.
- **Anti-Pattern Violations**: file + line, severity, one-line fix.
- **Build Shape**: pass/fail per check.
- **Recommendations**: prioritized. File Hot Sheet tickets (`hs-task`/`hs-bug`)
  for non-trivial findings.
