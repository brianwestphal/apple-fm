# AI Requirements Summary

Compact digest of [../3-requirements.md](../3-requirements.md) for AI agents.
Keep status markers in sync with the implementation.

> The Swift helper compiles against the macOS 26 SDK and is **smoke-verified
> on-device** (probe/generate/stream/schema/chat all work). Remaining: an
> automated device test in CI (AF-2). The unit suite runs device-free via the
> stub helper.

## Functional

- **FR-1 Probe availability** — Shipped. `helper.ts:probe` + Swift `--probe`; reasons mapped. Stub-tested + smoke-verified on-device.
- **FR-2 One-shot generate** — Shipped. `helper.ts:generate` + Swift `--generate`. Stub-tested + smoke-verified on-device.
- **FR-3 Streaming (`--stream`)** — Shipped. NDJSON `delta` events; helper diffs cumulative partials. Smoke-verified on-device.
- **FR-4 Conversation input** — Shipped. `protocol.ts:flattenMessages`.
- **FR-5 Interactive chat REPL** — Shipped. `repl.ts` (`/reset`, `/system`, `/clear`, `/compact`, `/help`, `/quit`; `/exit` alias).
- **FR-6 Auto-compaction** — Shipped. `session.ts:ChatSession` (`compactAtTokens`, `keepRecentTurns`). Unit-tested.
- **FR-7 Guided output (`--schema`)** — Shipped. Native guided generation (schema compiled to a `GenerationSchema`); output guaranteed to conform. See FR-8.
- **FR-8 Native `DynamicGenerationSchema`** — Shipped. Helper compiles the JSON Schema → `GenerationSchema`, `respond(to:schema:)`; strict (`unsupportedSchema` on an unsupported construct). Numeric min/max enforced; `schema`+`stream` emits full-JSON `snapshot` events. See `docs/6-guided-generation.md`.
- **FR-9 CLI surface** — Shipped. `cliArgs.ts`.
- **FR-10 Programmatic API** — Shipped. `index.ts`.
- **FR-11 Helper discovery** — Shipped. `APPLE_FM_BIN` → bundled binary → PATH.
- **FR-12 Persistent live session** — Shipped. `--session` helper mode (`runSession`) + Node `LiveSession`; `ChatSession` uses it as its backend, replacing transcript-replay. See `docs/7-live-session.md`.
- **FR-13 Homebrew distribution** — Dropped. npm is sufficient; descoped.
- **FR-14 Tool calling (extensible, permission-gated)** — Partial. **Phases 1–3 shipped + on-device verified**: generic round-trip plumbing (Swift `DynamicTool` suspends each call, round-tripped to Node over a `tool_call`/`tool_result` extension of `--session`, bound at `reset`), an extensible `ToolRegistry` (`src/tools/`), the `read` + `bash` built-ins, and a per-call `PermissionPolicy` gate (`ask`/`allow`/`deny`, REPL `[y/N/a]`, `--allow-tool`/`--deny-tool`/`--yes`/`/tools`, deny-by-default non-interactive; a denial is fed back as a tool result so the model continues). Remaining (AF-5): `web` (AFM-34 — breaks NFR-1, user-approved if permission-gated). Reqs `docs/9-tool-calling.md` + `docs/10-permissions.md` + `docs/11-builtin-tools.md`; design `docs/8-tool-support.md`.

## Non-functional

- **NFR-1 On-device only, no key/network** — Shipped.
- **NFR-2 Bounded/diagnosable subprocess** — Shipped (timeout + stderr + error codes).
- **NFR-3 Pure unit-tested, native stub-tested** — Shipped (`tests/fixtures/stub-helper.js`).
- **NFR-4 Strict TS / ESM / lint-clean / zero deps** — Shipped.
- **NFR-5 Forward-compatible with OS/model updates** — Shipped by design (runtime `SystemLanguageModel.default`).
- **NFR-6 Surface model drift** — Dropped. Golden-output suite (AF-4) descoped.
- **NFR-7 Signed + notarized release binary** — Shipped. `release.yml` `apple-fm` job Developer-ID-signs + notarizes the helper on macOS 26 and bundles it; verified on the v0.1.0 release (`apple-fm@0.1.0` on npm). See `docs/5-releasing.md`.

## Tracked follow-ups

AF-2 (automated on-device test in CI — CI compiles the helper; running the model
needs a self-hosted macOS 26 + Apple Intelligence runner, still pending).
AF-5 (tool calling, FR-14 — phases 1–3 shipped/on-device verified under AFM-31/32/33;
web remains, AFM-34; reqs `docs/9-tool-calling.md` + `docs/10-permissions.md` +
`docs/11-builtin-tools.md`).
