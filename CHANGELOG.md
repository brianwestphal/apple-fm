# Changelog

All notable changes to apple-fm are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning.

## [1.3.0] - 2026-11-25


### Features

- Discover the available on-device Foundation Models and choose which one to use.
- Count tokens with the model's own tokenizer. Chat now budgets its context with these counts and shows live context usage.
- Save native chat transcripts and resume them later.
- Attach one or more local images to generation prompts (macOS 27).
- Tag content on-device with a new content-tagging use case.
- Option to use greedy sampling for deterministic output.
- Interactive chat shows sanitized tool activity as it happens.

### Fixes

- Builds on macOS 26 with the system Bash 3.2.
- Validates guided-generation schemas before generation starts. Validates command arguments and numeric flags up front.
- Chat runs one operation at a time and saves only complete turns. Cancellation now reaches the turn that is running or queued.
- Tool calls are more reliable: one deadline covers each live tool call, stalled helpers are replaced, late or stale replies are ignored, and pending calls are settled when input ends.
- Tool approvals stay tied to the tool and file that were approved. Permission prompts appear one at a time and handle end of input cleanly.
- Helper messages and diagnostics have size limits.

## [1.2.0] - 2026-07-22


### Features
- Tool calling: the model can now invoke built-in `read` and `bash` tools during chat, each gated by a per-call permission prompt.
- Press **Esc** to interrupt an in-flight reply.

### Fixes
- Hardened the `read`/`bash` tools and the permission gate against untrusted model output, and tightened probe parsing.
- Tool output is now capped to the on-device context window.
- Model-runtime errors (including context-window-exceeded, which now triggers a compaction retry) surface as clean, readable errors.

## [1.0.1] - 2026-06-20


### Releases

No user-facing changes in this release.

## [1.0.0] - 2026-06-19


### Features

- apple-fm now installs on any platform — non-macOS systems install cleanly and degrade gracefully instead of failing, while the on-device model remains available on macOS 26+.
- Helper binaries are now signed and notarized.

## [Unreleased]

### Changed

- **Installs on any OS.** Dropped the `os: ["darwin"]` gate so apple-fm can be a
  dependency of cross-platform projects without breaking their install on
  Linux/Windows. The on-device model still only runs on macOS 26+ Apple Silicon;
  off-platform it degrades gracefully — `probe()` returns
  `{ available: false, reason: 'unsupportedPlatform' }` and `generate` / `chat`
  throw a clear `[unsupportedPlatform]` error. New `isPlatformSupported()` export.

## [0.1.0] - 2026-06-19

First tagged release.

### Added

- Swift `apple-fm-helper` (`--probe` / `--generate` / `--session`) over an NDJSON
  wire protocol, and a tested, **zero-runtime-dependency** Node layer.
- CLI (`apple-fm`): `probe`, `generate` (prompt or stdin; `--system`, `--schema`,
  `--stream`, `--temp`, `--max-tokens`), and an interactive `chat` with slash
  commands (`/reset`, `/system`, `/clear`, `/compact`, `/help`, `/quit`).
- Library API: `probe`, `generate`, `ChatSession`, `LiveSession`, protocol
  helpers, and types.
- **Native guided generation.** `--schema` compiles a JSON Schema to a
  `GenerationSchema`, so the model's output is *guaranteed* to conform (numeric
  `minimum` / `maximum` enforced); structured output can also stream, as JSON
  snapshots.
- **Persistent multi-turn chat.** `chat` reuses one on-device
  `LanguageModelSession` across turns (KV-cache) instead of replaying the
  transcript, and auto-compacts older turns near the context window.

### Verified

- Smoke-verified on a macOS 26 / Apple Intelligence machine: probe, generate
  (freeform / guided / streamed), guaranteed structured output, and multi-turn
  chat.

### Not yet done

- An automated on-device test in CI (AF-2) and the signed + notarized release
  pipeline (AF-12, verified on the first tagged release) are tracked.
