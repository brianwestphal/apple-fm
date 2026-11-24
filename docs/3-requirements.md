# 3. Requirements

Status markers: **Shipped** (implemented + tested), **Partial** (implemented,
gaps noted — including code that needs on-device verification), **Deferred**
(planned, tracked by an `AF-` ticket), **Dropped** (descoped — kept for history).

> **On-device verification.** CI compiles the Swift helper with the macOS 26 and
> 27 SDKs. The model has been **smoke-verified on an Apple Intelligence Mac**:
> `probe`, `generate`, `--stream`, `--schema`, and the `chat` REPL all produce
> correct output. `npm run test:device` automates native smoke checks on an
> eligible Mac. The unit suite runs device-free against the stub helper.

## Functional requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| FR-1 | Probe model availability | **Shipped** | Lists [models and their availability](12-models.md). The legacy status describes the on-device model. |
| FR-2 | One-shot text generation (`generate`) | **Shipped** | `helper.ts:generate` + Swift `--generate`; `prompt` or `messages`, `system`, `temperature`/`maxTokens`. Unit-tested; smoke-verified on-device. |
| FR-3 | Streaming output (`--stream`) | **Shipped** | Deltas over NDJSON; helper diffs cumulative partials from `streamResponse`. Unit-tested; smoke-verified on-device. |
| FR-4 | Conversation input (`messages[]`) | **Shipped** | Flattened to labeled turns (`protocol.ts:flattenMessages`; Swift `userPrompt`). |
| FR-5 | Interactive chat REPL (`chat`) | **Shipped** | `repl.ts` over `ChatSession`; slash commands `/reset`, `/system`, `/clear`, `/compact`, `/usage`, `/save`, `/help`, `/quit` (`/exit` alias); **Esc interrupts the in-flight reply** (FR-15); an empty model reply prints `(no response)` rather than a blank line (AFM-42). Smoke-verified on-device. |
| FR-6 | Automatic context compaction | **Shipped** | `session.ts:ChatSession` summarizes older turns past `compactAtTokens`, keeps `keepRecentTurns` verbatim; recap folded into the system prompt. Unit-tested. |
| FR-7 | Guided / structured output (`--schema`) | **Shipped** | Native guided generation (no longer prompt-guided): the JSON Schema is compiled to a `GenerationSchema` and the output conforms to the enforced subset. Smoke-verified on-device. See FR-8 / [6-guided-generation.md](6-guided-generation.md). |
| FR-8 | Native guided generation via `DynamicGenerationSchema` | **Shipped** | `apple-fm-helper` compiles the request JSON Schema to a `DynamicGenerationSchema`/`GenerationSchema` and uses `respond(to:schema:)` for guaranteed structure; **strict** — unsupported structural constructs fail with `unsupportedSchema`, no prompt-guided fallback. Numeric `minimum`/`maximum` are enforced; `schema`+`stream` streams full-JSON `snapshot` events. Smoke-verified on-device. See [6-guided-generation.md](6-guided-generation.md). |
| FR-9 | CLI surface: `probe` / `tokens` / `generate` / `chat`, `--help`, `--version` | **Shipped** | `generate` and `chat` accept [`--model`](12-models.md). |
| FR-10 | Programmatic API | **Shipped** | `index.ts`: `probe`, `generate`, `ChatSession`, protocol helpers, types. |
| FR-11 | Helper discovery | **Shipped** | `resolveHelperPath` checks the trusted `binPath` and `APPLE_FM_BIN` overrides before the bundled absolute `bin/apple-fm-helper` path. |
| FR-12 | Persistent live session (KV-cache reuse) | **Shipped** | The `--session` helper mode holds one `LanguageModelSession` across turns (`runSession`); the Node `LiveSession` (`liveSession.ts`) drives it and `ChatSession` uses it as its backend, **replacing** transcript-replay for `chat`. Compaction stays in Node (summarize → reset + reseed); crash → respawn + reseed. Smoke-verified on-device. See [7-live-session.md](7-live-session.md). |
| FR-13 | Homebrew distribution | **Dropped** | npm distribution is sufficient; a signed + notarized Homebrew tap is descoped. Revisit if there's demand. |
| FR-15 | Interrupt the in-flight reply (Esc) | **Shipped** | The REPL aborts the current turn when the user presses **Esc** while the model is replying (AFM-37). A new `cancel` session command ([4-protocol.md](4-protocol.md)) cancels the helper's turn task; the turn ends by emitting its normal `result` with the **partial** text (not an error), threaded through `LiveSession.send(…, signal)` → `ChatSession.send(…, signal)` → `repl.ts` (keypress → `AbortController`). The user prompt and the partial reply are **kept in history** so a follow-up stays coherent; the REPL prints `(interrupted)`. Esc is active only on a real TTY. Node path unit-tested device-free (stub `cancel`/`STREAM_FOREVER`); the **Swift cancel path is on-device verified** (AFM-45): a streaming turn `cancel`ed mid-flight stopped `streamResponse`, emitted a clean partial `result` (not an error/hang), and the session stayed usable for the next turn. The literal Esc keypress in a TTY remains a quick manual smoke (MT-1 in [manual-test-plan.md](manual-test-plan.md)) but exercises only the unit-tested keypress→abort wiring. |
| FR-16 | On-device content tagging | **Shipped** | `generate --use-case content-tagging` accepts text and returns a JSON tag array. See [model use cases](12-models.md) (AFM-AADSBY). |
| FR-17 | Native token counting | **Shipped** | `tokens` and `probe` expose native counts and context capacity. Chat uses native accounting when available (AFM-RT2FK2). `/usage` reports current occupancy (AFM-MBMXY7). |
| FR-18 | On-device image input | **Shipped** | Repeatable `generate --image` supports general and guided generation on macOS 27+ with the SDK 27 helper (AFM-K4DHM0). |
| FR-19 | Greedy sampling | **Shipped** | `generate --sampling greedy` selects Apple’s greedy decoding mode (AFM-C7EA41). |
| FR-20 | Save and resume chat | **Shipped** | `/save` writes a private versioned snapshot. `chat --resume` restores the native transcript with the same tools and the new invocation’s permissions (AFM-3YNEKV). |
| FR-14 | Tool calling (extensible, permission-gated) | **Shipped** | **On-device verified:** generic round-trip plumbing (a Swift `DynamicTool` adapter that suspends each call and round-trips it to Node over a `tool_call`/`tool_result` extension of `--session`), an extensible `ToolRegistry`, the `read` / `bash` built-ins, and a **per-call permission gate** (`ask`/`allow`/`deny`, REPL `[y/N/a]` prompt, `--allow-tool`/`--deny-tool`/`--yes`/`/tools`, deny-by-default when non-interactive). The real model used both tools and recovered when denied. Under AFM-30/31/32/33. (A networked `web` tool shipped under AFM-34 but was **removed in AFM-43** — the on-device model wasn't reliable enough with it; apple-fm makes no network calls, restoring NFR-1.) See [9-tool-calling.md](9-tool-calling.md), [10-permissions.md](10-permissions.md), [11-builtin-tools.md](11-builtin-tools.md), [8-tool-support.md](8-tool-support.md). |

## Non-functional requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| NFR-1 | Offline and on-device | **Shipped** | Inference and built-in tools run locally. Prompts stay on-device and inference works offline without an API key. |
| NFR-2 | Helper subprocess bounded + diagnosable | **Shipped** | Timeout + stderr capture in `helper.ts:runHelper`; structured error events. |
| NFR-3 | Pure logic unit-tested; native/process layer stub-tested | **Shipped** | Vitest; `tests/fixtures/stub-helper.js` emulates the protocol — no device needed. |
| NFR-4 | Strict TypeScript, ESM, lint-clean | **Shipped** | `strictTypeChecked`; `.js` import extensions; zero runtime deps. |
| NFR-5 | Forward-compatible with OS/model updates | **Shipped** (by design) | Helper resolves `SystemLanguageModel.default` at runtime. The deployment floor is macOS 26 on arm64. New framework APIs can require a newer SDK at build time and a newer OS at runtime. |
| NFR-6 | Behavioral drift across model updates surfaced | **Dropped** | A golden-output regression suite (AF-4) was considered and descoped. Revisit if drift becomes a problem in practice. |
| NFR-7 | Signed + notarized prebuilt helper in releases | **Shipped** | The `apple-fm` job builds with Xcode 27 targeting macOS 26+, signs with Developer ID, and notarizes with `notarytool`. npm bundles the resulting artifact when available and always includes the Swift source and build script. See [5-releasing.md](5-releasing.md). |

## Open items / tracked follow-ups

- **AF-2** automated real-model smoke tests run locally on the maintainer’s
  Apple Intelligence Mac with `npm run test:device` (AFM-T8C35G, AFM-T4E8PE).
  See the [device smoke instructions](manual-test-plan.md).
- **AF-5** tool calling (FR-14). Designed under AFM-30
  ([8-tool-support.md](8-tool-support.md)); requirements in
  [9-tool-calling.md](9-tool-calling.md) + [10-permissions.md](10-permissions.md).
  **Shipped** (AFM-31/32/33) — generic plumbing + `read` + permission gate + `bash`,
  on-device verified. (A `web` fetch tool shipped under AFM-34 then was **removed in
  AFM-43**; NFR-1 restored — no network.) An automated on-device tool test folds into
  AF-2.
