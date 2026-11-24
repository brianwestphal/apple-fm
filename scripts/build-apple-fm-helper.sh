#!/usr/bin/env bash
# Compile the Apple Foundation Models helper (apple-fm-helper/*.swift) — the
# native Swift binary that apple-fm shells out to. The helper is split across a
# few .swift files (main.swift holds the entry point); they share one module and
# are compiled together.
#
# GUARDED so it never breaks a build: it no-ops with exit 0 on non-macOS, when
# swiftc is missing, or when the macOS 26 SDK (FoundationModels) isn't present.
# On a capable machine it emits the helper binary at $1 (default ./bin/apple-fm-helper);
# point apple-fm at it with APPLE_FM_BIN, or run from a directory where
# ./bin/apple-fm-helper is resolvable.
#
# Code-signing: set CODESIGN_IDENTITY to sign the binary (needed if you ship it
# to other machines — the helper must be signed + notarized to run elsewhere).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/bin/apple-fm-helper}"
SRCDIR="$ROOT/apple-fm-helper"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[apple-fm] not macOS — skipping helper build"; exit 0
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "[apple-fm] swiftc not found — skipping helper build"; exit 0
fi
if [[ ! -f "$SRCDIR/main.swift" ]]; then
  echo "[apple-fm] source missing ($SRCDIR/main.swift) — skipping"; exit 0
fi

mkdir -p "$(dirname "$OUT")"

# Capture swiftc's diagnostics to a per-run temp file (not a hardcoded shared
# /tmp path, which breaks where /tmp is read-only and collides across builds).
LOG="$(mktemp "${TMPDIR:-/tmp}/apple-fm-build.XXXXXX.log")"
trap 'rm -f "$LOG"' EXIT

# Apple Intelligence is arm64-only and needs the macOS 26 SDK for FoundationModels.
# Compile every .swift in the helper dir into one binary (one shared module).
sources=("$SRCDIR"/*.swift)
if ! swiftc -O -target arm64-apple-macos26 "${sources[@]}" -o "$OUT" 2>"$LOG"; then
  echo "[apple-fm] build failed (needs the macOS 26 SDK / Xcode 26) — skipping:"
  sed 's/^/[apple-fm]   /' "$LOG" || true
  exit 0
fi

if [[ -n "${CODESIGN_IDENTITY:-}" ]]; then
  # Hardened runtime + secure timestamp are required for notarization.
  codesign --force --options runtime --timestamp --sign "$CODESIGN_IDENTITY" "$OUT"
  echo "[apple-fm] signed with $CODESIGN_IDENTITY"
fi

echo "[apple-fm] built $OUT"
