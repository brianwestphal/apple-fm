# 2. Architecture

Two layers: a **native helper** that owns all contact with `FoundationModels`,
and a **Node layer** that drives it over line-delimited JSON (NDJSON).

```
apple-fm (bin)  ── parseArgs (cliArgs.ts)
   │
   ├─ probe     → probe()    ─┐
   ├─ generate  → generate() ─┤  helper.ts ──(spawn + NDJSON)──▶ apple-fm-helper (Swift)
   └─ chat      → runRepl()   │                                    └─ FoundationModels
                  └ ChatSession (session.ts) ──┘                       (SystemLanguageModel)
                        auto-compaction
```

## Modules (`src/`)

| File | Responsibility |
| --- | --- |
| `types.ts` | Shared types: `Message`, `GenerateRequest`, `ProbeResult`, `HelperEvent`, `HelperOptions`. |
| `protocol.ts` | Pure NDJSON helpers: `encodeRequest`, `splitLines`, `parseEvent`, `flattenMessages`, `estimateTokens`, `estimateConversationTokens`. |
| `helper.ts` | Process layer: `resolveHelperPath`, `probe`, `generate` (spawn the helper, stream deltas, surface errors/timeouts). |
| `session.ts` | `ChatSession` — multi-turn history + automatic context compaction. |
| `cliArgs.ts` | `parseArgs()` + `USAGE` (pure, testable). |
| `repl.ts` | Interactive chat loop (readline around `ChatSession`). |
| `cli.ts` | The `apple-fm` bin (thin: parse → I/O → delegate). |
| `index.ts` | Public API surface. |

## Native helper (`apple-fm-helper/main.swift`)

A standalone Swift executable (built by `scripts/build-apple-fm-helper.sh`, not by
any package manager). It exposes two modes — `--probe` and `--generate` — over the
NDJSON protocol in [4-protocol.md](4-protocol.md). It is the only code that
imports `FoundationModels`, so the rest of the system is testable without a
macOS 26 device.

## Data flow

1. `cli.ts` parses argv into a `ParsedArgs`.
2. **probe** → `helper.probe()` spawns `--probe`, reads the single availability
   line.
3. **generate** → `helper.generate()` spawns `--generate`, writes the request
   JSON on stdin, reads `delta`/`result`/`error` events; `--schema` adds guided
   output, `--stream` forwards deltas.
4. **chat** → `repl.ts` drives a `ChatSession`. Each turn calls `generate` with
   the full transcript; when the estimated size crosses `compactAtTokens`, the
   session summarizes older turns (another on-device call) and continues with the
   recap plus the most recent turns.

## Trust boundaries

- **Helper subprocess** — bounded by a timeout; stderr captured and surfaced on
  failure; stdin EPIPE swallowed if the helper exits early.
- **Helper output** — every line is parsed as a known NDJSON event; unknown
  shapes throw rather than being silently dropped.
- **On-device model** — runs locally; no network egress. Availability and failure
  reasons (`appleIntelligenceNotEnabled`, `contextWindowExceeded`, …) are
  reported as structured codes.

## Distribution

- **npm** — `apple-fm` ships the compiled `bin/apple-fm-helper` (force-included in
  package `files`); the Node layer resolves it relative to the package, or via
  `APPLE_FM_BIN`, or from `PATH`.
- **Homebrew** — planned; a signed + notarized binary tap (AF-13).
