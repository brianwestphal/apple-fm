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
- **FR-7 Guided output (`--schema`)** — Partial. Prompt-guided (schema injected into instructions), returns schema-valid JSON on-device; native path is AF-1.
- **FR-8 Native `DynamicGenerationSchema`** — Deferred. AF-1.
- **FR-9 CLI surface** — Shipped. `cliArgs.ts`.
- **FR-10 Programmatic API** — Shipped. `index.ts`.
- **FR-11 Helper discovery** — Shipped. `APPLE_FM_BIN` → bundled binary → PATH.
- **FR-12 Persistent live session** — Deferred. AF-3.
- **FR-13 Homebrew distribution** — Dropped. npm is sufficient; descoped.

## Non-functional

- **NFR-1 On-device only, no key/network** — Shipped.
- **NFR-2 Bounded/diagnosable subprocess** — Shipped (timeout + stderr + error codes).
- **NFR-3 Pure unit-tested, native stub-tested** — Shipped (`tests/fixtures/stub-helper.js`).
- **NFR-4 Strict TS / ESM / lint-clean / zero deps** — Shipped.
- **NFR-5 Forward-compatible with OS/model updates** — Shipped by design (runtime `SystemLanguageModel.default`).
- **NFR-6 Surface model drift** — Dropped. Golden-output suite (AF-4) descoped.
- **NFR-7 Signed + notarized release binary** — Partial. AF-12: `release.yml` `apple-fm` job signs + notarizes the helper on macOS 26 and bundles it; awaiting secrets + first release (see `docs/5-releasing.md`).

## Tracked follow-ups

AF-1 (native guided gen), AF-2 (automated on-device test in CI — CI now compiles
the helper, on-device run pending), AF-3 (live session), AF-12
(signing/notarization CI — pipeline implemented, pending secrets/first release).
