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
- **Cancel command:** `{"type":"cancel","id":"7"}` interrupts the in-flight turn
  (FR-15, esc-to-interrupt). The helper cancels the turn's task and the turn ends by
  emitting its normal `result` with the **partial** text so far; `LiveSession` wires
  this to an optional `AbortSignal` on `send`, and the REPL aborts on the Esc key.

These are additive: `--probe` / `--generate` and their wire shapes are untouched.

## Implementation surface

- **`apple-fm-helper/main.swift`** — add `--session`: hold one
  `LanguageModelSession`, read commands in a loop, dispatch turn vs reset, emit
  id-tagged events, exit on EOF.
- **`src/helper.ts`** (or a new `liveSession.ts`) — a `LiveSession` that spawns the
  `--session` helper once, writes commands, parses id-correlated events, and
  exposes `send(input, onDelta?) → Promise<string>` and `reset(system, seed)`.
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

## Open questions / risks

- Long-lived process hygiene: zombie helpers if Node exits abnormally — ensure
  cleanup (kill on `close`/process exit).
- Does the SDK expose per-turn token usage / a reliable context-overflow signal on
  a live session? Drives when Node triggers compaction.
- Re-seed fidelity: confirm a reset+seed reproduces the same context a fresh replay
  would, so recovery is transparent.

## Follow-up tickets

Implementation is tracked separately so this doc can land first — see the tickets
created from AFM-12.
