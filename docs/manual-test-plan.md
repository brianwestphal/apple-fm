# Manual Test Plan

Cases that can't be reliably automated yet (a real on-device model, or a real TTY)
live here. Everything device-free is covered by the unit + e2e suites (`npm test`);
the standing automated on-device gap is **AF-2** in [3-requirements.md](3-requirements.md).

When a case here gains automated coverage, remove it and note it under
**Automated Coverage Summary** below.

## MT-1 — Esc interrupts the in-flight reply (FR-15)

Esc-to-interrupt needs a real TTY (keypress events + raw mode), so it is verified
manually. The Node↔helper `cancel` round-trip and history-keeping are unit-tested
device-free (`tests/liveSession.test.ts`, `tests/session.test.ts`); this case covers
the live keypress path and the real model actually stopping.

**Steps**

1. `npm run build:helper` (real helper) and ensure the model is ready
   (`./bin/apple-fm-helper --probe` → `{"available":true}`; if generation returns
   `modelNotReady`, the assets are still provisioning — wait and retry).
2. `npm run build && node dist/cli.js chat --stream` (or `apple-fm chat`).
3. Ask for something long, e.g. *"Write a 500-word essay about the Roman Empire."*
4. While tokens are streaming, press **Esc**.

**Expected**

- Streaming stops promptly; the REPL prints `(interrupted)` on its own line and
  returns to the `> ` prompt.
- No error is printed (the turn ends with the partial reply, not an `error`).
- A follow-up like *"continue"* / *"summarize what you just wrote"* shows the model
  remembers the partial reply (it was kept in history).
- Pressing Esc when **no** reply is in flight does nothing harmful.
- `/help` mentions the Esc interrupt.

## MT-2 — `web` extraction on a real content-heavy page (AFM-39)

Readability extraction is unit-tested with injected HTML; this confirms it helps on a
real page within the on-device window.

**Steps**

1. `apple-fm chat --tools web` (approve the fetch when prompted).
2. Ask: *"Summarize https://en.wikipedia.org/wiki/Roman_Empire"*.
3. Optionally set `APPLE_FM_WEB_MAX_CHARS=8000` and repeat on a larger-window machine.

**Expected**

- The returned text is mostly article prose (not nav/footer/related-links).
- The model produces a relevant summary rather than failing on noise; long pages page
  with `offset` (the result notes how to continue).

## Automated Coverage Summary

- *(none yet — the device-free protocol/round-trip parts of MT-1 and MT-2 are covered
  by the unit + e2e suites; the on-device + TTY parts above remain manual under AF-2.)*
