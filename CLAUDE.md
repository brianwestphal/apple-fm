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
> `--schema`, and `chat` all work. Native guided generation (FR-8) and a signed +
> notarized release binary (NFR-7) have shipped. The one remaining item tracked in
> [docs/3-requirements.md](docs/3-requirements.md) is an **automated** on-device
> test in CI (AF-2); the Node layer is fully unit-tested against a stub helper
> (device-free).

## Architecture

Two layers, talking NDJSON (see [docs/4-protocol.md](docs/4-protocol.md)):

- **Native** — `apple-fm-helper/*.swift` (entry point in `main.swift`,
  guided-generation schema translation in `GuidedGeneration.swift`): the only code
  importing `FoundationModels`. Modes `--probe`, `--generate`, and the long-lived
  `--session`. All `.swift` files compile into one binary via
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
  probe, generate, resolveHelperPath, isPlatformSupported, HELPER_BIN_ENV,
  ChatSession, LiveSession,
  encodeRequest, splitLines, parseEvent, flattenMessages,
  estimateTokens, estimateConversationTokens,
} from 'apple-fm';
import type {
  Message, Role, GenerateRequest, GenerateOptions, ProbeResult, UnavailableReason,
  HelperEvent, HelperOptions, DeltaHandler, SnapshotHandler,
  ChatSessionConfig, GenerateFn, ChatBackend, LiveSessionConfig,
} from 'apple-fm';
```

## Adding a feature

- **New helper capability** (e.g. native guided generation, AF-1): add it in
  `apple-fm-helper/main.swift`, extend the protocol in `docs/4-protocol.md`, mirror
  it in `src/protocol.ts` / `src/helper.ts`, and update
  `tests/fixtures/stub-helper.js` so the suite still covers it.
- **New CLI flag**: `cliArgs.ts` (+ wire in `cli.ts`); add a `cliArgs.test.ts` case.
- **New chat behavior**: `session.ts`; test with an injected `GenerateFn`.
- Keep the layering: only the Swift helper imports `FoundationModels`; only the
  process layer (`helper.ts` for one-shot, `liveSession.ts` for the persistent
  session) spawns; pure logic stays pure.

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

Two ID schemes coexist, deliberately: `AF-N` are **requirement follow-up
identifiers** used throughout `docs/` (e.g. AF-1 native guided generation); the
Hot Sheet tracker issues its own ticket numbers with the `AFM-` prefix (AFM-1,
AFM-2, …). They are not the same numbering — an `AF-N` doc item may be picked up
by an `AFM-N` ticket, but the numbers need not line up.

<!-- hotsheet:begin section=ticket-driven-work v=1 -->
## Ticket-Driven Work

When the user gives you work directly (not via the Hot Sheet channel or events), create Hot Sheet tickets before starting implementation — especially for substantial or multi-step work.

- **Do create tickets** for: features, bug fixes, refactoring, multi-step tasks, anything changing code. **Don't** for: simple questions, git commits, quick lookups, trivial one-liners. **When in doubt, create them.**
- Create via the Hot Sheet API (prefer the `hotsheet_*` MCP tools), mark Up Next, then work through them: set status `started` → implement → set `completed` with notes.
- **Always create follow-up tickets** for incomplete work (unfinished steps, open design questions, known gaps, designed-but-unbuilt features). If it's not in a ticket, it's forgotten.
- **Incomplete-work checklist** — before marking a ticket `completed`, file follow-ups for any: (1) UI placeholder text ("coming soon"), (2) TODO/FIXME comments, (3) documented-but-unimplemented requirements, (4) empty/stub functions returning mock data.
- **Use FEEDBACK NEEDED before deferring or asking about follow-ups.** When about to (a) defer a ticket needing more work, (b) ask whether to file follow-ups, or (c) close with a question buried in notes — DON'T. Leave the ticket `started`, add a `FEEDBACK NEEDED:` note (per `.hotsheet/worklist.md`), signal channel done, and wait. It's the only reliable way to surface a question.
<!-- hotsheet:end section=ticket-driven-work -->

<!-- hotsheet:begin section=testing-philosophy v=1 -->
## Testing Philosophy

- **Double coverage**: every feature covered by both unit tests AND E2E tests. Unit = logic in isolation; E2E = real user flows through the running app with minimal mocking.
- **Unit tests**: Mock external deps (filesystem, network), test real logic.
- **E2E tests**: As much as possible, use test automation tools to run realistic, user-facing flows. Minimize mocks.
- **Coverage**: Merge all test coverage (e.g. unit, E2E server, E2E browser) into one report. Low-coverage files should get more of both test types. Aim for 100% coverage of code lines, 100% coverage of branches, and 100% of features described in the requirements documentation.
- **Manual test plan**: keep a manual test plan doc (e.g. `docs/manual-test-plan.md`) for features that can't be reliably automated. **Keep it up to date** — add such features there; when you add automated coverage for a previously-manual item, remove it and note it in an "Automated Coverage Summary".
- **Always fix lint and type errors before finishing**: Fix as you go, don't batch.

<!-- hotsheet:begin specifics=testing-philosophy v=1 -->
### This project's test setup

- **Unit tests** (`tests/**/*.test.ts`): [vitest](https://vitest.dev) with v8 coverage. Test the pure logic directly — `protocol.ts`, `cliArgs.ts`, and `session.ts` (the last via an injected `GenerateFn`). The process layer (`helper.ts`) runs against `tests/fixtures/stub-helper.js`, a JS reimplementation of the NDJSON protocol, so the suite needs **no macOS 26 device**. Never call the real on-device model in a unit test.
- **E2E (device-free)** (`tests/e2e/cli.e2e.test.ts`, AFM-25): spawns the **real** `apple-fm` CLI (`src/cli.ts` run through `tsx`) as a child process with `APPLE_FM_BIN` pointed at the stub helper, asserting stdout/stderr and exit codes across `probe` / `generate` (incl. `--stream`, `--schema`, stdin, and the `modelNotReady` / `inferenceFailed` / `unsupportedSchema` error paths) and the `chat` REPL slash commands. This exercises the assembled CLI wiring (`cli.ts`, `repl.ts`) end-to-end without a device, and runs as part of `npm test`.
- **E2E / on-device**: still manual. Real Swift-helper behaviour against the model — and its error mapping (e.g. `modelNotReady`, `failure(for:)`) — is verified by manual smoke testing; an automated on-device CI test is tracked as **AF-2** in [docs/3-requirements.md](docs/3-requirements.md). There is no `docs/manual-test-plan.md` yet — add one if manual-only cases start to accumulate.
- **Commands**: unit + e2e `npm test` (`vitest run --coverage`) · lint `npm run lint` · typecheck `npm run typecheck`. Coverage is produced by `npm test`; thresholds live in `vitest.config.ts` (statements 80, branches 75, functions 80, lines 80). `cli.ts` / `repl.ts` are excluded from the **coverage report** as thin I/O (the e2e suite spawns them in a child process, so they are covered functionally but not by in-process v8 instrumentation).
<!-- hotsheet:end specifics=testing-philosophy -->
<!-- hotsheet:end section=testing-philosophy -->

<!-- hotsheet:begin section=requirements-documentation v=1 -->
## Requirements Documentation

Keep human-readable requirements documents as the source of truth for what the project does, and **keep them up to date in the same change as the code** (add/remove/modify a requirement → update its doc). Create new docs for major new functional areas. Cross-reference related docs with relative links.

### AI Summaries

Maintain two synthesis docs an AI assistant reads at the start of a fresh session — keep them in sync with reality (source doc/code wins on conflict), and prefer small targeted edits over rewrites:

- A **codebase map** — directory tree, entry points, data schema, build, tests, settings, and a "where do I look for X" index. Update it in the same change when you add a file or directory, add a route/endpoint, change the schema, add a client module, or add a setting key.
- A **requirements summary** — a synthesized view of every requirements doc with status markers (e.g. Shipped / Partial / Design only / Deferred). Update it in the same change when you add a requirements doc, ship a design-only feature, or defer/regress a shipped one.

<!-- hotsheet:begin specifics=requirements-documentation v=1 -->
### This project's docs layout

- **Requirements docs** live in `docs/` as numbered topic files (`1-overview.md` … `7-live-session.md`). `docs/3-requirements.md` is the FR/NFR source of truth, with a status marker on each requirement.
- **Codebase map**: [docs/ai/code-summary.md](docs/ai/code-summary.md). **Requirements summary**: [docs/ai/requirements-summary.md](docs/ai/requirements-summary.md). Keep both in sync with the code and source docs in the same change.
<!-- hotsheet:end specifics=requirements-documentation -->
<!-- hotsheet:end section=requirements-documentation -->
