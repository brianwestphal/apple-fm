# AI Code Summary

A compact map of the codebase for AI agents. Keep in sync with `src/` when code
changes.

## Directory tree

```
src/
  types.ts        # shared types: Message, GenerateRequest, ProbeResult, HelperEvent, HelperOptions
  protocol.ts     # pure NDJSON: encodeRequest, splitLines, parseEvent, flattenMessages, estimateTokens, estimateConversationTokens
  helper.ts       # process layer: resolveHelperPath, probe, generate (spawn helper, stream, timeout)
  session.ts      # ChatSession (multi-turn history + auto-compaction); GenerateFn
  cliArgs.ts      # parseArgs() + USAGE
  repl.ts         # interactive chat loop (runRepl) — readline over ChatSession
  cli.ts          # apple-fm bin (thin)
  index.ts        # public API surface
apple-fm-helper/main.swift   # Swift FoundationModels CLI (--probe / --generate; built by scripts/build-apple-fm-helper.sh)
tests/            # protocol, cliArgs, session, helper (+ fixtures/stub-helper.js)
```

## Public API (`src/index.ts`)

- Process: `probe(options?)`, `generate(request, options?, onDelta?)`,
  `resolveHelperPath(options?)`, `HELPER_BIN_ENV`.
- Chat: `ChatSession` (`send`, `compact`, `shouldCompact`, `history`, `reset`);
  types `ChatSessionConfig`, `GenerateFn`.
- Protocol: `encodeRequest`, `splitLines`, `parseEvent`, `flattenMessages`,
  `estimateTokens`, `estimateConversationTokens`.
- Types: `Message`, `Role`, `GenerateRequest`, `GenerateOptions`, `ProbeResult`,
  `UnavailableReason`, `HelperEvent`, `HelperOptions`, `DeltaHandler`.

## Where do I look to…

| Task | Look at |
| --- | --- |
| change the wire protocol (events, framing) | `protocol.ts` + `docs/4-protocol.md` + `apple-fm-helper/main.swift` |
| change how the helper binary is found/spawned | `helper.ts` (`resolveHelperPath`, `runHelper`) |
| change chat behavior or compaction policy | `session.ts` (`ChatSession`, `SUMMARIZE_SYSTEM`) |
| change guided generation (`--schema` → native) | `apple-fm-helper/main.swift` (`dynamicSchema`, `compileSchema`, `generate`) |
| add a persistent live-session mode (AF-3) | `apple-fm-helper/main.swift` + a new `session.ts` backend |
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
