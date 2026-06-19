# 3. Requirements

Status markers: **Shipped** (implemented + tested), **Partial** (implemented,
gaps noted — including code that needs on-device verification), **Deferred**
(planned, tracked by an `AF-` ticket), **Dropped** (descoped — kept for history).

> **On-device verification.** The Swift helper compiles against the macOS 26 SDK
> and has been **smoke-verified on a macOS 26 / Apple Intelligence machine**:
> `probe`, `generate`, `--stream`, `--schema`, and the `chat` REPL all produce
> correct output (e.g. the guided path returned schema-valid JSON). What remains
> is an **automated** on-device test in CI (AF-2); the unit suite still runs
> device-free against the stub helper.

## Functional requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| FR-1 | Probe on-device model availability | **Shipped** | `helper.ts:probe` + Swift `--probe`; reasons mapped (`deviceNotEligible`/`appleIntelligenceNotEnabled`/`modelNotReady`). Unit-tested via stub; smoke-verified on-device. |
| FR-2 | One-shot text generation (`generate`) | **Shipped** | `helper.ts:generate` + Swift `--generate`; `prompt` or `messages`, `system`, `temperature`/`maxTokens`. Unit-tested; smoke-verified on-device. |
| FR-3 | Streaming output (`--stream`) | **Shipped** | Deltas over NDJSON; helper diffs cumulative partials from `streamResponse`. Unit-tested; smoke-verified on-device. |
| FR-4 | Conversation input (`messages[]`) | **Shipped** | Flattened to labeled turns (`protocol.ts:flattenMessages`; Swift `userPrompt`). |
| FR-5 | Interactive chat REPL (`chat`) | **Shipped** | `repl.ts` over `ChatSession`; slash commands `/reset`, `/system`, `/clear`, `/compact`, `/help`, `/quit` (`/exit` alias). Smoke-verified on-device. |
| FR-6 | Automatic context compaction | **Shipped** | `session.ts:ChatSession` summarizes older turns past `compactAtTokens`, keeps `keepRecentTurns` verbatim; recap folded into the system prompt. Unit-tested. |
| FR-7 | Guided / structured output (`--schema`) | **Shipped** | Native guided generation (no longer prompt-guided): the JSON Schema is compiled to a `GenerationSchema` and the output is guaranteed to conform. Smoke-verified on-device. See FR-8 / [6-guided-generation.md](6-guided-generation.md). |
| FR-8 | Native guided generation via `DynamicGenerationSchema` | **Shipped** | `apple-fm-helper` compiles the request JSON Schema to a `DynamicGenerationSchema`/`GenerationSchema` and uses `respond(to:schema:)` for guaranteed structure; **strict** — an unsupported construct fails with `unsupportedSchema`, `schema`+`stream` with `badRequest`, no prompt-guided fallback. Smoke-verified on-device (object/enum/array/bool). See [6-guided-generation.md](6-guided-generation.md). |
| FR-9 | CLI surface: `probe` / `generate` / `chat`, `--help`, `--version` | **Shipped** | `cliArgs.ts` (+ `cli.ts`). |
| FR-10 | Programmatic API | **Shipped** | `index.ts`: `probe`, `generate`, `ChatSession`, protocol helpers, types. |
| FR-11 | Helper discovery | **Shipped** | `resolveHelperPath`: `APPLE_FM_BIN` → bundled `bin/apple-fm-helper` → `PATH`. |
| FR-12 | Persistent live session (KV-cache reuse) | **Deferred** | AF-3. Designed — see [7-live-session.md](7-live-session.md): a `--session` helper mode holding one `LanguageModelSession` across turns, **replacing** transcript-replay for `chat`. Compaction policy stays in Node. |
| FR-13 | Homebrew distribution | **Dropped** | npm distribution is sufficient; a signed + notarized Homebrew tap is descoped. Revisit if there's demand. |

## Non-functional requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| NFR-1 | On-device only; no network, no API key | **Shipped** | Node never imports a cloud SDK; the helper only calls `FoundationModels`. |
| NFR-2 | Helper subprocess bounded + diagnosable | **Shipped** | Timeout + stderr capture in `helper.ts:runHelper`; structured error events. |
| NFR-3 | Pure logic unit-tested; native/process layer stub-tested | **Shipped** | Vitest; `tests/fixtures/stub-helper.js` emulates the protocol — no device needed. |
| NFR-4 | Strict TypeScript, ESM, lint-clean | **Shipped** | `strictTypeChecked`; `.js` import extensions; zero runtime deps. |
| NFR-5 | Forward-compatible with OS/model updates | **Shipped** (by design) | Helper resolves `SystemLanguageModel.default` at runtime; deployment target is a floor (`arm64-apple-macos26`). New models/OSes need no rebuild. |
| NFR-6 | Behavioral drift across model updates surfaced | **Dropped** | A golden-output regression suite (AF-4) was considered and descoped. Revisit if drift becomes a problem in practice. |
| NFR-7 | Signed + notarized prebuilt helper in releases | **Partial** | AF-12. CI pipeline implemented: `.github/workflows/release.yml` `apple-fm` job Developer-ID-signs (`build:helper` + `CODESIGN_IDENTITY`) and notarizes (`notarytool`) the helper on a macOS 26 runner, then bundles it into the npm tarball. Awaiting one-time secrets setup + first tagged release to verify — see [5-releasing.md](5-releasing.md). |

## Open items / tracked follow-ups

- **AF-2** *automated* on-device smoke test in CI (manual smoke test done). CI
  now *compiles* the helper on a macOS 26 runner (`ci.yml` `helper-build` job),
  catching Swift/API regressions; running the model on-device is still pending.
- **AF-3** persistent live-session helper mode.
- **AF-12** signing + notarization CI — pipeline implemented (`release.yml`),
  pending secrets + first release; see [5-releasing.md](5-releasing.md).
