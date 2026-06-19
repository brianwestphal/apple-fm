# CLAUDE.md

Guidance for working in the **apple-fm** codebase.

## What this is

`apple-fm` gives command-line and programmatic access to Apple's **on-device
Foundation Models** (Apple Intelligence) on macOS 26+. Apple ships
`FoundationModels` as Swift-only API with no CLI; apple-fm provides one. A tiny
Swift helper owns all contact with the framework; a tested, typed Node layer
drives it over line-delimited JSON. Ships as a library and a CLI (`apple-fm`),
distributed via npm.

> **Status:** the Swift helper compiles against the macOS 26 `FoundationModels`
> API and is **smoke-verified on-device** — `probe`, `generate`, `--stream`,
> `--schema`, and `chat` all work. Remaining work is tracked in
> [docs/3-requirements.md](docs/3-requirements.md): an automated on-device test in
> CI (AF-2), native guided generation (AF-1), and signing/notarization (AF-12).
> The Node layer is fully unit-tested against a stub helper (device-free).

## Architecture

Two layers, talking NDJSON (see [docs/4-protocol.md](docs/4-protocol.md)):

- **Native** — `apple-fm-helper/main.swift`: the only code importing
  `FoundationModels`. Modes `--probe` and `--generate`. Built by
  `scripts/build-apple-fm-helper.sh` (guarded: no-ops on non-macOS / missing SDK).
- **Node (`src/`)**
  - `types.ts` — shared types (`Message`, `GenerateRequest`, `ProbeResult`,
    `HelperEvent`, `HelperOptions`).
  - `protocol.ts` — pure NDJSON helpers (`encodeRequest`, `splitLines`,
    `parseEvent`, `flattenMessages`, `estimateTokens`,
    `estimateConversationTokens`).
  - `helper.ts` — process layer (`resolveHelperPath`, `probe`, `generate`):
    spawns the helper, streams deltas, bounds it with a timeout, surfaces errors.
  - `liveSession.ts` — `LiveSession` (the `ChatBackend`): one long-lived
    `apple-fm-helper --session` process held across turns (KV-cache reuse),
    id-correlated commands, lazy respawn. See [docs/7-live-session.md](docs/7-live-session.md).
  - `session.ts` — `ChatSession`: multi-turn history + automatic context
    compaction (summarize older turns past `compactAtTokens`, keep
    `keepRecentTurns` verbatim) over a `LiveSession` backend. The summarizer is
    injectable (`GenerateFn`) and the backend is injectable (`ChatBackend`) for
    tests.
  - `cliArgs.ts` — `parseArgs()` + `USAGE` (pure, testable).
  - `repl.ts` — interactive chat loop (`runRepl`).
  - `cli.ts` — the `apple-fm` bin (thin).
  - `index.ts` — public API.

## Public API (`src/index.ts`)

```ts
import {
  probe, generate, resolveHelperPath, HELPER_BIN_ENV,
  ChatSession,
  encodeRequest, splitLines, parseEvent, flattenMessages,
  estimateTokens, estimateConversationTokens,
} from 'apple-fm';
import type {
  Message, Role, GenerateRequest, GenerateOptions, ProbeResult, UnavailableReason,
  HelperEvent, HelperOptions, DeltaHandler, ChatSessionConfig, GenerateFn,
} from 'apple-fm';
```

## Adding a feature

- **New helper capability** (e.g. native guided generation, AF-1): add it in
  `apple-fm-helper/main.swift`, extend the protocol in `docs/4-protocol.md`, mirror
  it in `src/protocol.ts` / `src/helper.ts`, and update
  `tests/fixtures/stub-helper.js` so the suite still covers it.
- **New CLI flag**: `cliArgs.ts` (+ wire in `cli.ts`); add a `cliArgs.test.ts` case.
- **New chat behavior**: `session.ts`; test with an injected `GenerateFn`.
- Keep the layering: only the Swift helper imports `FoundationModels`; only
  `helper.ts` spawns; pure logic stays pure.

## Conventions

- ESM only, `type: "module"`. Use `.js` extensions in relative imports.
- Strict TypeScript + `typescript-eslint` `strictTypeChecked`. `import type` for
  type-only imports. Avoid truthy checks on strings (`strict-boolean-expressions`).
- **Zero runtime dependencies** — the Node layer only spawns the helper and
  speaks JSON. Keep `package.json` `dependencies` empty.
- Public functions and exported types carry TSDoc.

## Commands

```bash
npm test            # vitest unit tests with coverage
npm run test:watch  # vitest watch
npm run lint        # eslint over src/ and tests/
npm run typecheck   # tsc --noEmit
npm run build       # tsup → dist/ (index + cli, with .d.ts)
npm run build:helper # compile apple-fm-helper (macOS 26; guarded no-op elsewhere)
npm run dev         # tsup --watch
npm run clean       # rm -rf dist coverage node_modules/.cache
npm run demo         # re-capture the README demo SVGs (assets/demos/) — needs the on-device model
npm run release      # interactive release (bump, changelog, tag); CI publishes
npm run release:beta # beta tag-only flow (npm install apple-fm@beta)
```

`prepublishOnly` (runs `build`) fires automatically on `npm publish`. The
release flow and its one-time CI signing setup are documented in
[docs/5-releasing.md](docs/5-releasing.md).

## Testing

Keep native/process/git-style calls thin and test the pure logic directly:
`protocol.ts`, `cliArgs.ts`, and `session.ts` (via an injected `GenerateFn`). The
process layer (`helper.ts`) is tested against `tests/fixtures/stub-helper.js`, a
JS reimplementation of the NDJSON protocol — so the suite needs no macOS 26
device. Don't call the real on-device model in unit tests. Coverage thresholds
(`vitest.config.ts`): statements 80, branches 75, functions 80, lines 80; `cli.ts`
and `repl.ts` are excluded as thin I/O.

## Documentation

- [docs/1-overview.md](docs/1-overview.md) — what apple-fm is and its principles.
- [docs/2-architecture.md](docs/2-architecture.md) — module layout and data flow.
- [docs/3-requirements.md](docs/3-requirements.md) — FR/NFR requirements with status.
- [docs/4-protocol.md](docs/4-protocol.md) — the helper ⇄ Node wire protocol.
- [docs/5-releasing.md](docs/5-releasing.md) — release flow + one-time CI signing/notarization setup.
- [docs/6-guided-generation.md](docs/6-guided-generation.md) — design for native guided generation (FR-8 / AFM-11).
- [docs/7-live-session.md](docs/7-live-session.md) — design for the persistent live-session helper (FR-12 / AFM-12).
- [docs/ai/code-summary.md](docs/ai/code-summary.md) — AI-oriented code map.
- [docs/ai/requirements-summary.md](docs/ai/requirements-summary.md) — AI-oriented requirements digest.

Keep `docs/ai/*` and the requirement status markers in sync when code changes.

Two ID schemes coexist, deliberately: `AF-N` are **requirement follow-up
identifiers** used throughout `docs/` (e.g. AF-1 native guided generation); the
Hot Sheet tracker issues its own ticket numbers with the `AFM-` prefix (AFM-1,
AFM-2, …). They are not the same numbering — an `AF-N` doc item may be picked up
by an `AFM-N` ticket, but the numbers need not line up.
