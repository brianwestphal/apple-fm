# Changelog

All notable changes to apple-fm are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
semantic versioning.

## [Unreleased]

### Added

- Initial scaffold: Swift `apple-fm-helper` (`--probe` / `--generate`) over an
  NDJSON wire protocol, and a tested, zero-dependency Node layer.
- CLI (`apple-fm`): `probe`, `generate` (prompt or stdin, `--system`, `--schema`,
  `--stream`, `--temp`, `--max-tokens`), and an interactive `chat`.
- Library API: `probe`, `generate`, `ChatSession` (multi-turn history with
  automatic context compaction), plus protocol helpers and types.
- Docs (`docs/1`–`4`, `docs/ai/*`), custom skills, and a unit-test suite that
  runs against a stub helper (no macOS 26 device required).

### Verified

- Smoke-verified on a macOS 26 / Apple Intelligence machine: `probe`, `generate`,
  `--stream`, `--schema` (returns schema-valid JSON), and the `chat` REPL.

### Not yet done

- Automated on-device test in CI (AF-2), native guided generation via
  `DynamicGenerationSchema` (AF-1), a persistent live-session mode (AF-3), and
  signed/notarized release binaries (AF-12) are tracked but not implemented.
