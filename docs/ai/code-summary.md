# AI Code Summary

A compact map of the codebase for AI agents. Keep in sync with `src/` when code
changes.

## Directory tree

```
src/
  types.ts        # shared types: Message, GenerateRequest, ProbeResult, HelperEvent, HelperOptions
  protocol.ts     # pure NDJSON: encodeRequest, splitLines, parseEvent, flattenMessages, estimateTokens, estimateConversationTokens
  helper.ts       # process layer: resolveHelperPath, probe, generate (spawn helper, stream, timeout)
  liveSession.ts  # LiveSession: one long-lived `--session` helper; ChatBackend (turn/reset/close, id-correlated)
  session.ts      # ChatSession (multi-turn over a LiveSession backend + auto-compaction); GenerateFn
  cliArgs.ts      # parseArgs() + USAGE
  repl.ts         # interactive chat loop (runRepl) — readline over ChatSession
  cli.ts          # apple-fm bin (thin)
  index.ts        # public API surface
  tools/          # tool calling (FR-14): Tool/ToolContext/ToolDefinition (types.ts), ToolRegistry (registry.ts), registryFromNames + BUILTIN_TOOLS (index.ts), builtin/read.ts + bash.ts + web.ts, PermissionPolicy (permissions.ts)
apple-fm-helper/             # Swift FoundationModels CLI (--probe / --generate / --session); all *.swift compiled into one binary by scripts/build-apple-fm-helper.sh
  main.swift                 # entry point, output/emit, probe, generate, session loop (+ tool-call routing)
  GuidedGeneration.swift     # JSON Schema -> DynamicGenerationSchema/GenerationSchema (compileSchema)
  Tools.swift                # tool calling (FR-14): DynamicTool, ToolBridge (suspend/resume), buildTools
tests/            # protocol, cliArgs, session, helper, liveSession, docs, demo (+ fixtures/stub-helper.js)
  e2e/cli.e2e.test.ts        # spawns the real CLI (src/cli.ts via tsx) against the stub; asserts stdout/exit codes
```

## Public API (`src/index.ts`)

- Process: `probe(options?)`, `generate(request, options?, onDelta?, onSnapshot?)`,
  `resolveHelperPath(options?)`, `isPlatformSupported()`, `HELPER_BIN_ENV`.
- Chat: `ChatSession` (`send`, `compact`, `shouldCompact`, `history`, `reset`,
  `close`); `LiveSession` (`send`, `reset`, `close`); types `ChatSessionConfig`,
  `GenerateFn`, `ChatBackend`, `LiveSessionConfig`.
- Tools (FR-14): `ToolRegistry`, `registryFromNames`, `toolGuidancePrompt`,
  `readTool`, `bashTool`, `webTool`, `BUILTIN_TOOLS`, `PermissionPolicy`; types `Tool`,
  `ToolContext`, `ToolDefinition`, `PermissionMode`, `PermissionRequest`,
  `PermissionAsker`, `AskOutcome`, `PermissionPolicyConfig`.
- Protocol: `encodeRequest`, `splitLines`, `parseEvent`, `flattenMessages`,
  `estimateTokens`, `estimateConversationTokens`.
- Types: `Message`, `Role`, `GenerateRequest`, `GenerateOptions`, `ProbeResult`,
  `UnavailableReason`, `HelperEvent`, `HelperOptions`, `DeltaHandler`,
  `SnapshotHandler`.

## Where do I look to…

| Task | Look at |
| --- | --- |
| change the wire protocol (events, framing) | `protocol.ts` + `docs/4-protocol.md` + `apple-fm-helper/main.swift` |
| change how the helper binary is found/spawned | `helper.ts` (`resolveHelperPath`, `runHelper`) |
| change the persistent live-session process/protocol | `liveSession.ts` (`LiveSession`) + `apple-fm-helper/main.swift` (`runSession`) |
| change chat behavior or compaction policy | `session.ts` (`ChatSession`, `SUMMARIZE_SYSTEM`) |
| change guided generation (`--schema` → native) | `apple-fm-helper/GuidedGeneration.swift` (`dynamicSchema`, `compileSchema`) + `main.swift` (`generate`) |
| add/change a CLI flag | `cliArgs.ts` (+ wire in `cli.ts`) |
| change interactive REPL commands | `repl.ts` |
| change Esc/interrupt of an in-flight reply (FR-15) | `repl.ts` (keypress → `AbortController`) + `session.ts`/`liveSession.ts` (`send(…, signal)` → `cancel` command) + `apple-fm-helper/main.swift` (`cancel` case + `sessionTurn` cancellation) + `docs/4-protocol.md` (`cancel`) + stub `cancel`/`STREAM_FOREVER`. |
| change the on-device calls (probe/respond/stream) | `apple-fm-helper/main.swift` |
| add or change a tool / the tool round-trip (FR-14) | `src/tools/` (registry + built-ins `read`/`bash`/`web`) + `liveSession.ts` (dispatcher) + `apple-fm-helper/Tools.swift` (`DynamicTool`) + `docs/4-protocol.md` + `docs/9-tool-calling.md` + `docs/11-builtin-tools.md`. Phases 1–4 shipped; only a `web` search backend remains (TC-9). |
| change `web` page extraction / paging / cap (AFM-39) | `src/tools/builtin/web.ts` (`htmlToText` readability heuristic, `windowText` paging, `WEB_MAX_CHARS_ENV`) + `docs/12-web-extraction.md` (WX-1…7). Env: `APPLE_FM_WEB_MAX_CHARS` widens the per-fetch cap. |
| change tool permissions / the prompt | `src/tools/permissions.ts` (`PermissionPolicy`) + `liveSession.ts` (gate in `handleToolCall`) + `repl.ts` (`readlineAsker`, `/tools`) + `cliArgs.ts` (`--allow-tool`/`--deny-tool`/`--yes`) + `docs/10-permissions.md`. |

## Testing

- `npm test` — vitest with coverage. The native + process paths run against
  `tests/fixtures/stub-helper.js` (a JS reimplementation of `docs/4-protocol.md`),
  so no macOS 26 device is required.
- `tests/e2e/cli.e2e.test.ts` (AFM-25) — device-free e2e: spawns the real CLI
  (`src/cli.ts` via `tsx`) as a child process against the stub helper and asserts
  stdout/stderr + exit codes for `probe` / `generate` / `chat` and their error
  paths, covering `cli.ts` / `repl.ts` end-to-end. On-device e2e (real Swift
  helper) is still manual — AF-2.
- Coverage thresholds (`vitest.config.ts`): statements 80, branches 75,
  functions 80, lines 80. `cli.ts` and `repl.ts` (thin I/O) are excluded from the
  coverage report (the e2e suite covers them in a child process, not via in-process
  instrumentation).

## Update triggers

- New `src/*.ts` file → add to the tree and the "where do I look" table.
- New public export → update the Public API list here and `src/index.ts`.
- Protocol change → update `docs/4-protocol.md`, the Swift helper, and the stub.
