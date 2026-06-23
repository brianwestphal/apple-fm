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
| FR-8 | Native guided generation via `DynamicGenerationSchema` | **Shipped** | `apple-fm-helper` compiles the request JSON Schema to a `DynamicGenerationSchema`/`GenerationSchema` and uses `respond(to:schema:)` for guaranteed structure; **strict** — an unsupported construct fails with `unsupportedSchema`, no prompt-guided fallback. Numeric `minimum`/`maximum` are enforced; `schema`+`stream` streams full-JSON `snapshot` events. Smoke-verified on-device. See [6-guided-generation.md](6-guided-generation.md). |
| FR-9 | CLI surface: `probe` / `generate` / `chat`, `--help`, `--version` | **Shipped** | `cliArgs.ts` (+ `cli.ts`). |
| FR-10 | Programmatic API | **Shipped** | `index.ts`: `probe`, `generate`, `ChatSession`, protocol helpers, types. |
| FR-11 | Helper discovery | **Shipped** | `resolveHelperPath`: `APPLE_FM_BIN` → bundled `bin/apple-fm-helper` → `PATH`. |
| FR-12 | Persistent live session (KV-cache reuse) | **Shipped** | The `--session` helper mode holds one `LanguageModelSession` across turns (`runSession`); the Node `LiveSession` (`liveSession.ts`) drives it and `ChatSession` uses it as its backend, **replacing** transcript-replay for `chat`. Compaction stays in Node (summarize → reset + reseed); crash → respawn + reseed. Smoke-verified on-device. See [7-live-session.md](7-live-session.md). |
| FR-13 | Homebrew distribution | **Dropped** | npm distribution is sufficient; a signed + notarized Homebrew tap is descoped. Revisit if there's demand. |
| FR-14 | Tool calling (extensible, permission-gated) | **Partial** | **Phases 1–3 shipped + on-device verified:** generic round-trip plumbing (a Swift `DynamicTool` adapter that suspends each call and round-trips it to Node over a `tool_call`/`tool_result` extension of `--session`), an extensible `ToolRegistry`, the `read` + `bash` built-ins, and a **per-call permission gate** (`ask`/`allow`/`deny`, REPL `[y/N/a]` prompt, `--allow-tool`/`--deny-tool`/`--yes`/`/tools`, deny-by-default when non-interactive). The real model used `read` and `bash` and recovered when denied. Remaining (AF-5): `web` (phase 4 — breaks NFR-1; user-approved *if* permission-gated, fetch + search). Under AFM-30/31/32/33. See [9-tool-calling.md](9-tool-calling.md), [10-permissions.md](10-permissions.md), [11-builtin-tools.md](11-builtin-tools.md), [8-tool-support.md](8-tool-support.md). |

## Non-functional requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| NFR-1 | On-device only; no network, no API key | **Shipped** | Node never imports a cloud SDK; the helper only calls `FoundationModels`. |
| NFR-2 | Helper subprocess bounded + diagnosable | **Shipped** | Timeout + stderr capture in `helper.ts:runHelper`; structured error events. |
| NFR-3 | Pure logic unit-tested; native/process layer stub-tested | **Shipped** | Vitest; `tests/fixtures/stub-helper.js` emulates the protocol — no device needed. |
| NFR-4 | Strict TypeScript, ESM, lint-clean | **Shipped** | `strictTypeChecked`; `.js` import extensions; zero runtime deps. |
| NFR-5 | Forward-compatible with OS/model updates | **Shipped** (by design) | Helper resolves `SystemLanguageModel.default` at runtime; deployment target is a floor (`arm64-apple-macos26`). New models/OSes need no rebuild. |
| NFR-6 | Behavioral drift across model updates surfaced | **Dropped** | A golden-output regression suite (AF-4) was considered and descoped. Revisit if drift becomes a problem in practice. |
| NFR-7 | Signed + notarized prebuilt helper in releases | **Shipped** | `.github/workflows/release.yml` `apple-fm` job Developer-ID-signs (`build:helper` + `CODESIGN_IDENTITY`) and notarizes (`notarytool`) the helper on a macOS 26 runner, then bundles it into the published npm tarball. **Verified on the v0.1.0 release** — signing + `npm-publish` jobs green; `apple-fm@0.1.0` is on npm. See [5-releasing.md](5-releasing.md). |

## Open items / tracked follow-ups

- **AF-2** *automated* on-device smoke test in CI (manual smoke test done). CI
  now *compiles* the helper on a macOS 26 runner (`ci.yml` `helper-build` job),
  catching Swift/API regressions; running the model on-device is still pending
  (hosted runners lack Apple Intelligence — needs a self-hosted macOS 26 runner).
- **AF-5** tool calling (FR-14). Designed under AFM-30
  ([8-tool-support.md](8-tool-support.md)); requirements in
  [9-tool-calling.md](9-tool-calling.md) + [10-permissions.md](10-permissions.md).
  **Phases 1 (AFM-31) + 2 (AFM-32) + 3 (AFM-33) shipped** — generic plumbing + `read`
  + permission gate + `bash`, on-device verified. Remaining: (4, AFM-34) `web` (breaks
  NFR-1; user-approved if permission-gated). An automated on-device tool test folds
  into AF-2.
