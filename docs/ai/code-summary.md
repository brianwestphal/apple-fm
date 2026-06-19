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
apple-fm-helper/             # Swift FoundationModels CLI (--probe / --generate / --session); all *.swift compiled into one binary by scripts/build-apple-fm-helper.sh
  main.swift                 # entry point, output/emit, probe, generate, session loop
  GuidedGeneration.swift     # JSON Schema -> DynamicGenerationSchema/GenerationSchema (compileSchema)
tests/            # protocol, cliArgs, session, helper (+ fixtures/stub-helper.js)
```

## Public API (`src/index.ts`)

- Process: `probe(options?)`, `generate(request, options?, onDelta?, onSnapshot?)`,
  `resolveHelperPath(options?)`, `isPlatformSupported()`, `HELPER_BIN_ENV`.
- Chat: `ChatSession` (`send`, `compact`, `shouldCompact`, `history`, `reset`,
  `close`); `LiveSession` (`send`, `reset`, `close`); types `ChatSessionConfig`,
  `GenerateFn`, `ChatBackend`, `LiveSessionConfig`.
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
| change the on-device calls (probe/respond/stream) | `apple-fm-helper/main.swift` |

## Testing

- `npm test` — vitest with coverage. The native + process paths run against
  `tests/fixtures/stub-helper.js` (a JS reimplementation of `docs/4-protocol.md`),
  so no macOS 26 device is required.
- Coverage thresholds (`vitest.config.ts`): statements 80, branches 75,
  functions 80, lines 80. `cli.ts` and `repl.ts` (thin I/O) are excluded.

## Update triggers

- New `src/*.ts` file → add to the tree and the "where do I look" table.
- New public export → update the Public API list here and `src/index.ts`.
- Protocol change → update `docs/4-protocol.md`, the Swift helper, and the stub.
