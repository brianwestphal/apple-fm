# Manual Test Plan

The device-free suite is available with `npm test`. A separate smoke suite runs
the real helper and model. The manual cases below cover behavior such as physical
terminal input and image failures.

## Automated device smoke (AF-2)

On an Apple Silicon Mac with Apple Intelligence enabled and its model available,
run these commands from the checkout. Use Xcode 27 and macOS 27 to exercise the
image check.

```sh
npm ci
npm run build
npm run build:helper
npm run test:device
```

The smoke checks probe, streamed generation, guided generation, a permission-gated
read during streaming, native transcript restore, and ordered multi-image input
on macOS 27. It uses temporary synthetic files and images. The project runs this
suite locally on the maintainer’s Mac (AFM-T4E8PE).

When a case here gains automated coverage, remove it and note it under
**Automated Coverage Summary** below.

## MT-1 — Esc interrupts the in-flight reply (FR-15)

Esc-to-interrupt needs a real TTY (keypress events + raw mode), so it is verified
manually. The Node↔helper `cancel` round-trip and history-keeping are unit-tested
device-free (`tests/liveSession.test.ts`, `tests/session.test.ts`), and the **Swift
cancel path is on-device verified** (AFM-45 — a streaming turn `cancel`ed mid-flight
stopped `streamResponse`, emitted a clean partial `result`, and the session stayed
usable). This case now only covers the **live TTY keypress** (readline `keypress` →
`AbortController`), the one bit not exercised automatically.

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

## Automated Coverage Summary

- *(none yet — the device-free protocol/round-trip part of MT-1 is covered by the unit
  + e2e suites; the on-device + TTY part above remains manual under AF-2.)*

## MT-2 Model discovery and selection

Build the helper and run it through the rebuilt CLI on macOS 26 and later.
Verify that probe lists only `on-device`. Select `--model on-device` and verify a
one-shot reply and a chat reply after `/clear`. Run `generate --use-case
content-tagging "We had a picnic at the beach"` and verify stdout parses as a
JSON array of relevant tags. With an SDK 27 helper on macOS 27, run
`generate --image` against a known image with and without `--schema`.
Repeat `--image` with two distinct images and verify the response refers to both
in order. Confirm that an unreadable image produces an error and that macOS 26 reports
the image mode as unsupported.

Run `/usage` in a new chat, after a reply, and after `/clear`. On a native
counting helper, verify the count rises after the reply and drops after clearing.

## MT-3 Save and resume

In the rebuilt CLI, ask chat to remember a short phrase and save with
`/save <new path>`. Exit and run `chat --resume <path>`. Ask for the phrase and
confirm the context survives. Repeat with a tool enabled and verify that the
new invocation uses its own approval rules.
