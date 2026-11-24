# Apple FM audit, 2026-11-24

Hot Sheet ticket **AFM-4EMS04**. Reviewed the requirements, then code hygiene,
then code quality. Follow-ups are linked to the audit ticket.

## Requirements and implementation

Compared `docs/3-requirements.md` with the CLI, library, native helper, tests,
and release workflows. The following coverage map records where each group
is implemented.

| Requirements | Implementation and evidence |
| --- | --- |
| FR-1–4 | `helper.ts`, `protocol.ts`, Swift `probe` and `generate`; protocol/helper tests, CLI tests, prior native smoke |
| FR-5–6, FR-12, FR-15 | `repl.ts`, `session.ts`, `liveSession.ts`, Swift `runSession`; native chat evidence and stub-backed compaction/cancel tests |
| FR-7–8 | Swift `GuidedGeneration.swift` and `generate`; guided/streaming tests and native smoke, with the input-validation gap below |
| FR-9–11 | `cliArgs.ts`, `cli.ts`, `index.ts`, `helper.ts:resolveHelperPath`; CLI, conventions and helper tests |
| FR-13–14 | npm release workflow and the Node tool registry, permission gate and Swift tool bridge; Homebrew remains dropped |
| FR-16–20 | Native tagging, token counting, image attachments, sampling and transcripts; CLI and unit coverage plus the native smoke recorded in their implementation tickets |
| NFR-1–5 | Native on-device inference, process timeouts and errors, stub-based test suite, strict TypeScript, macOS 26 deployment target and runtime-selected model |
| NFR-6–7 | Golden output remains dropped. The release workflow signs and notarizes with Xcode 27, targeting macOS 26. |

| Finding | Type | Disposition |
| --- | --- | --- |
| FR-11 still advertised lookup on `PATH`. `resolveHelperPath` uses `binPath`, then `APPLE_FM_BIN`, then the bundled absolute path. | Stale | Corrected the requirements and AI summary. AFM-FAFE08 covers the remaining architecture, examples and demo drift. |
| NFR-7 named the old macOS 26 build runner. Hosted jobs now build/probe on macOS 26 and 27. | Stale | Corrected the requirements and AI summary. The release evidence for the historical v0.1.0 remains historical. |
| FR-7/8 describe strict schema translation, but the translator ignores some malformed constraints or keys. The documented best-effort value constraints need a clear boundary around the guaranteed subset. | Different | AFM-KAGR8Y |
| NFR-2 describes bounded, diagnosable helpers. One-shot limits exist, while live timeouts can leave native work pending. Native error codes and live parsing also differ in detail from the protocol description. | Different | AFM-KP3NY0, AFM-KFY32V |
| Native CI exercises compile and probe. Real inference remains manual. | Deferred | AFM-T8C35G tracks AF-2. |
| Tool activity display, persistent approvals, aggregate tool time and old design questions remain open. | Deferred | AFM-N3PJE5, AFM-4195V2, AFM-7JTNX9, AFM-0SG6FT |

Synced the public API, helper modes and script list in `CLAUDE.md`. Updated
`docs/ai/code-summary.md` and `docs/ai/requirements-summary.md` for the current
process and session APIs. The documented coverage floors match
`vitest.config.ts`. Read requirements and design docs through
`docs/12-models.md`. Existing source requirements and native evidence were
used to interpret status. This audit did not change shipping behavior.

## Code hygiene

Relative source imports use the `.js` suffix and the package has zero runtime
dependencies. Framework imports remain in the Swift helper. One-shot and live
process spawning are confined to their process adapters. The lint checks found
no style errors or warnings.

| Severity | Category | Code and recommendation | Follow-up |
| --- | --- | --- | --- |
| High | Defensive | `GuidedGeneration.swift:intField` converts unvalidated numeric bounds to `Int`. Validate range and integer semantics before conversion and reject unsupported constraints consistently. | AFM-KAGR8Y |
| High | Defensive | `read.ts:readRegularFileBounded` performs filesystem checks separately from opening the path. Bind grant and file checks to the resource actually opened. | AFM-EF4W8R |
| High | Defensive | `LiveSession.dispatch` can send an early cancel before the turn. Swift cancels its current task without correlating the command ID. Clean up signal listeners and handle early and stale cancellation by ID. | AFM-61RARJ |
| High | Defensive | Live timeouts can leave work pending. `LiveSession.handleToolCall` uses the current child when an asynchronous tool reply arrives. Keep command and response lifetimes bound to the original child. | AFM-KP3NY0 |
| Medium | Defensive | `cliArgs.ts:parseNumber` checks only NaN. Reject nonfinite and out-of-domain values and validate extra command arguments before I/O. | AFM-RJKVMH |
| Medium | Standardization | One-shot and live NDJSON handle malformed output and diagnostics differently. A sandboxed native probe returned `contextSize: 0`; probe accepts it while live capability handling requires a positive size. Normalize the capability, diagnostics and validation contract. | AFM-KFY32V |
| Low | Maintenance | `cliArgs.ts`, `helper.ts`, `liveSession.ts`, `repl.ts`, and `session.ts` exceed the hygiene guide’s review threshold. Swift `main.swift` contains several distinct modes and a large session switch. Extract responsibilities with clear boundaries, including snapshot I/O, and name the context headroom fraction. | AFM-XSSR1A |

## Quality gates

- **274 tests passed** in 14 test files, including the device-free CLI suite.
- **Lint and typecheck passed.**
- **Node build passed.** Both JavaScript entries and their declarations are
  present. The CLI retains its `#!/usr/bin/env node` shebang.
- **Swift helper built** with the selected SDK. The isolated native probe
  reported `available: true`, `contextSize: 4096`, and one on-device model
  with normal access to the Apple Intelligence service. This verifies build and
  discovery. Full on-device inference in CI is still AFM-T8C35G.

Coverage is a minimum check. The transition review below identifies behavior
the percentages do not exercise.

| File | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| `cliArgs.ts` | 97.27% | 96.62% | 100% | 100% |
| `helper.ts` | 83.84% | 76.19% | 81.81% | 89.52% |
| `liveSession.ts` | 89.47% | 80.24% | 81.48% | 92.37% |
| `protocol.ts` | 94.82% | 93.54% | 100% | 100% |
| `session.ts` | 93.47% | 89.47% | 95.23% | 96.29% |
| `tools/dispatch.ts` | 100% | 95.83% | 100% | 100% |
| `tools/permissions.ts` | 97.77% | 94.59% | 100% | 100% |
| `tools/builtin/bash.ts` | 88.63% | 76.74% | 93.75% | 91.78% |
| `tools/builtin/read.ts` | 89.83% | 84.44% | 100% | 94.23% |
| **All instrumented files** | **91.73%** | **86.87%** | **92.56%** | **95.09%** |

`cli.ts` and `repl.ts` are excluded from those figures and covered as real
CLI subprocesses. The atomic snapshot file operation now contains enough
behavior to warrant direct filesystem tests (AFM-VB8BK6).

## Behavioral and state-transition assessment

| Component | State sequence | Verdict and missing cases |
| --- | --- | --- |
| `LiveSession` | Idle → spawn → pending turn → result/error → close or respawn; native capabilities negotiated on reset | **Partial.** Tests cover concurrent IDs, repeat respawn, abort and close while busy. Add pre-abort, stale cancel during a new turn, timeout followed by a new command, and delayed tool result after child replacement. AFM-61RARJ, AFM-KP3NY0 |
| `ChatSession` | Empty → turn history → budget threshold → compact/reseed → append; save → resume; failure → retry | **Partial.** Existing tests cover repeated compaction, reset/refill, one successful retry, native usage after reset, and resume. Add failed retry, close/reuse, queued operations during compaction, and save/resume while a turn is pending. AFM-33D06R, AFM-VB8BK6 |
| `PermissionPolicy` and readline asker | Match deny/allow or ask → one-shot decision or remembered grant → next request | **Partial.** Tests cover deny precedence and remembered grants. Add simultaneous asks answered in order, cancellation while awaiting an answer, and EOF with a prompt outstanding. AFM-FT19DR |
| `ToolRegistry` and dispatcher | Empty → register → advertise → authorize → execute or refuse; implementation can be replaced | **Partial.** Registration and replacement have standalone tests. Bind a registered implementation across a pending approval and test that replacing or registering tools after reset cannot change the authorized call. AFM-17X7T9 |
| `read` built-in | Resolve and authorize → validate file → open → read/close, or timeout | **Partial.** Tests cover grants, symlinks, non-regular files and timeout individually. Add descriptor identity and path-change cases around authorization and open. AFM-EF4W8R |
| `bash` built-in | Spawn → output collection → exit, oversized output, timeout or pipe grace | **Covered for reviewed transitions.** Tests exercise timeout, output cap, nonzero exit and descendants retaining a pipe. The live model’s aggregate tool-turn lifetime is tracked under AFM-7JTNX9. |
| Swift tool bridge | Begin turn → suspend a call → receive result, cancellation or reset → later turn | **Partial.** Stub tests cover normal round trips and permission denial. Native streaming with concurrent tool calls and a delayed result after cancellation needs explicit coverage. AFM-0SG6FT, AFM-KP3NY0, AFM-T8C35G |

The first fixes to schedule are native schema validation, file authorization at
open time, cancellation correlation, and live command lifetime. These have
concrete boundaries and can be verified independently. Keep persistence of tool
grants as a product decision under AFM-4195V2 because transcript resume currently
uses the new invocation’s permissions.
