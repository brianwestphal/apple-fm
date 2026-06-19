# Changelog

All notable changes to apple-fm are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning.

## [Unreleased]

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
