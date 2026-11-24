# 7. Persistent Live-Session Helper (FR-12 / AF-3)

Design + requirements for holding one `LanguageModelSession` across chat turns
instead of replaying the whole transcript each turn. Tracked by **FR-12** in
[3-requirements.md](3-requirements.md); designed under **AFM-12**, implemented
under **AFM-17**.

> **Status: Shipped.** The helper's `--session` mode (`runSession`) holds one
> `LanguageModelSession`; the Node `LiveSession` (`src/liveSession.ts`) drives it
> with id-correlated commands and lazy respawn; `ChatSession` uses it as its
> backend (`ChatBackend`), and the REPL closes it on exit. Smoke-verified
> on-device (multi-turn memory, streaming, reset, exit). The sections below are
> the design; the shipped behavior matches them.

## Previously

`chat` was stateless under the hood. Each turn, `ChatSession` (`src/session.ts`)
called the one-shot `generate` path, which spawned the helper, built a **fresh**
`LanguageModelSession`, and replayed the **entire** transcript as labeled turns
([4-protocol.md](4-protocol.md), FR-4). Every turn re-encoded all prior tokens —
quadratic work and no KV-cache reuse.

## Goal (FR-12)

Spawn the helper **once** for the chat's lifetime in a new `--session` mode that
holds a single `LanguageModelSession`. Each turn sends only the **new** user input;
the framework keeps the conversation state and reuses the KV-cache (cheaper +
faster, no re-encoding history).

## Decision: replace transcript-replay entirely

`chat` / `ChatSession` uses the live-session backend as its **sole** path — no
transcript-replay fallback. Simplest model; one code path to reason about.

Scope boundary:
- The **stateless one-shot `generate`** (CLI `generate`, library `generate`,
  `messages[]` conversation input / FR-4) is **unchanged** — it stays useful for
  scripting and is reused for `ChatSession`'s summarization sub-call.
- Only the interactive/multi-turn chat path moves to the live session.

Because there's no per-turn replay, **crash recovery** is explicit: Node still
holds the transcript in memory (for display + compaction), so if the long-lived
helper dies, Node restarts it and **re-seeds** from that history. That's a recovery
path, not the steady state.

## Protocol: `--session` mode

A third helper mode alongside `--probe` / `--generate`. The event vocabulary is
unchanged ([4-protocol.md](4-protocol.md)); what's new is that the helper is
**long-lived** and handles **many** requests, so requests and events are
**correlated by id**.

- Helper reads a stream of NDJSON **commands** on stdin and stays alive until EOF
  (then exits 0).
- **Turn command:** `{"id":"7","prompt":"…","options":{…},"stream":true}` → the
  helper calls `respond`/`streamResponse` on the held session and emits the usual
  `delta`/`result`/`error` events, each tagged with the same `id`.
- **Reset command:** `{"type":"reset","id":"8","system":"…","seed":[{"role":"…","content":"…"}]}`
  → recreate the `LanguageModelSession` with new `instructions` and optionally
  pre-seed prior turns; ack with `{"type":"ready","id":"8"}`. Used for `/reset`,
  `/clear`, compaction reseed, and crash recovery.
- Every event gains an `id` echoing its originating command so Node can correlate
  concurrent-looking traffic (in practice turns are serial).
- `contextWindowExceeded` is surfaced per turn so Node can compact + reset + reseed
  and retry (the compaction policy stays in Node).
- If a live command reaches its timeout, Node terminates its helper and rejects the
  other commands awaiting that process. Reset the replacement helper to restore
  context. Tool approvals and replies are valid only for their originating turn.
- **Cancel command:** `{"type":"cancel","id":"7"}` interrupts the identified turn
  (FR-15, esc-to-interrupt). An active turn returns the partial text and a queued
  turn returns an empty result in command order. `LiveSession.send` returns an
  empty result immediately if its `AbortSignal` already aborted. The REPL aborts
  on the Esc key.

These are additive: `--probe` / `--generate` and their wire shapes are untouched.

## Implementation surface

- **`apple-fm-helper/Session.swift`** holds the native session, processes commands
  in order, and routes tool replies and cancellation independently of the queue.
- **`src/liveSession.ts`** spawns the `--session` helper, writes commands, parses
  ID-correlated events, and exposes `send` and `reset`.
  Owns process lifecycle (timeout per turn, cleanup on close, restart-on-crash).
- **`src/session.ts`** — `ChatSession` uses `LiveSession` as its backend instead of
  replaying via `generate`. `GenerateFn` injection stays for device-free tests.
  Compaction is unchanged in spirit: summarize older turns (one-shot `generate`),
  then `reset` the live session with the recap as instructions + the kept recent
  turns as `seed`.
- **`src/repl.ts`** — spawns/owns the `LiveSession` for the REPL's lifetime; maps
  `/reset` `/clear` `/compact` to `reset`.
- **`docs/4-protocol.md`** — document `--session` (commands, `id` correlation,
  `reset`, `ready`).
- **`tests/fixtures/stub-helper.js`** — implement `--session` so the suite stays
  device-free.

## Testing

- Unit (device-free, stub): multi-turn `send` over one `LiveSession`; `id`
  correlation; `reset`/`ready`; `contextWindowExceeded` → compact + reseed; helper
  death → restart + reseed; process cleanup on close.
- `ChatSession` over an injected backend (existing pattern) for compaction policy.
- On-device smoke (AF-2): a real multi-turn session is coherent and faster than
  replay.

## Recovery and accounting (AFM-0SG6FT)

- A native context overflow is reported as `contextWindowExceeded`. Chat can
  compact and retry once. Native accounting measures the active transcript and,
  during a preflight check, the next prompt. The reported count represents current
  context occupancy. It has no cumulative session total.
- A crash, reset, or compaction rebuilds a session from instructions and labeled
  prior turns. This preserves the selected text and any recap. Native transcript
  entries and the model's cache are reconstructed differently. Use `/save` and
  `chat --resume` to export and import the native transcript.
- Closing a Node session tears down its helper. Native tool waiters at direct
  protocol EOF are tracked in AFM-DSA0MZ.

## Context usage

`/usage` prints the current context token count, context capacity, and percentage
on macOS 26.4 and later when the helper advertises native counting (AFM-MBMXY7).
Older helpers and failed native counts produce a labeled estimate. The count can
drop after `/clear` or `/compact` because it measures the active transcript.

## Save and resume

`ChatSession` runs send, usage, compaction, save, and resume operations in the order
the caller starts them. A successful send adds its prompt and reply together. A
failed send leaves no unmatched prompt, even when recovery also fails. `reset()`
clears history immediately. `close()` preserves committed history, which is reseeded
if the caller reuses the session. Either call invalidates work already in flight or
queued against the previous session state.

| Event | Snapshot or turn state after the event | Regression coverage |
| --- | --- | --- |
| Save succeeds | A complete private file is published atomically. | `tests/chatFile.test.ts`, CLI save/resume |
| A staged write fails or the destination already exists | Staging is removed. Any existing destination is preserved. | `tests/chatFile.test.ts` |
| Resume cannot read or validate the file | The CLI reports the error before initializing the backend. | `tests/chatFile.test.ts`, CLI resume errors |
| Reset or close interrupts queued chat work | The obsolete work cannot commit history or deliver deltas. | `tests/session.test.ts` |
| A tool reply arrives after completion, cancellation, or replacement | The matching waiter has already been removed. Current turns continue independently. | `tests/native-session-turns.swift`, `tests/liveSession.test.ts` |

In chat, `/save <file>` writes a new JSON snapshot containing the native
Foundation Models transcript, the current instructions, recent turns, and the
compaction summary (AFM-3YNEKV). The CLI creates the file with mode `0600` and
refuses to replace an existing path. The transcript can contain tool inputs and
outputs.

Resume with `apple-fm chat --resume <file>`. Use the same `--tools` selection as
the saved chat. Tool approvals come from the new invocation. The restored
transcript already includes system instructions. Use `/system` to start a fresh
context with different instructions.
