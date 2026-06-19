# 4. Wire Protocol

The Node layer and the Swift helper communicate over **line-delimited JSON
(NDJSON)** on stdin/stdout. The helper has three modes, selected by a flag:
`--probe`, the one-shot `--generate`, and the long-lived `--session`.

## `--probe`

No stdin. Emits exactly one JSON line that **is** the availability result (not an
event), then exits 0:

```json
{"available":true}
{"available":false,"reason":"appleIntelligenceNotEnabled"}
```

`reason` (present only when unavailable) is one of `deviceNotEligible`,
`appleIntelligenceNotEnabled`, `modelNotReady`, `unknown`.

## `--generate`

Reads **one** request object on stdin:

```json
{
  "system":   "optional instructions",
  "prompt":   "a single user turn",
  "messages": [{"role":"user","content":"…"}],
  "schema":   { "...": "optional JSON Schema for guided output" },
  "options":  { "temperature": 0.7, "maxTokens": 512 },
  "stream":   false
}
```

- Provide **either** `prompt` **or** `messages` (a conversation, replayed as
  labeled turns). `system` is delivered as the session's instructions.
- `schema`, when present, requests **native guided generation**: the helper
  compiles the JSON Schema to a `GenerationSchema` and the model output is
  guaranteed to conform (see [6-guided-generation.md](6-guided-generation.md)).
  A schema the native path can't express fails with `unsupportedSchema`; combining
  `schema` with `"stream":true` fails with `badRequest` (structured streaming is
  not yet implemented).

Writes a stream of NDJSON **events** to stdout:

| Event | When | Shape |
| --- | --- | --- |
| `delta` | streaming only (`"stream":true`), zero or more | `{"type":"delta","text":"…"}` |
| `result` | exactly one, on success | `{"type":"result","content":"…"}` |
| `error` | on failure (exit ≠ 0) | `{"type":"error","code":"…","message":"…"}` |

`delta.text` is the newly-appended suffix (the helper diffs the cumulative
partials from `streamResponse`). `result.content` is the full text — or, for
guided output, the JSON string.

### Error codes

`badRequest`, `unsupportedSchema`, `unavailable`, `contextWindowExceeded`,
`guardrailViolation`, `generationError`, `inferenceFailed`. The Node layer raises
these as thrown errors (`[code] message`); `ChatSession` may act on
`contextWindowExceeded` by compacting and retrying.

## `--session`

A **long-lived** mode (FR-12; see [7-live-session.md](7-live-session.md)) that holds
one `LanguageModelSession` across many turns so its KV-cache is reused — instead of
replaying the whole transcript each turn. It reads **one command per stdin line**,
processes them serially, and exits 0 on EOF.

Because many commands flow over one process, each command may carry an `id` that the
helper echoes on every event it produces, so the Node side can correlate them.

Commands:

| Command | Shape | Effect |
| --- | --- | --- |
| turn | `{"id":"7","prompt":"…","options":{…}?,"stream":bool?}` | Respond on the held session; emits `delta`* (when `stream`) then `result`, or `error` — all tagged with the `id`. The session is **not** reset, so prior turns remain in context. |
| reset | `{"type":"reset","id":"8","system":"…"?,"seed":[{"role","content"}]?}` | Recreate the session with `system` as instructions and `seed` folded in as a labeled recap (used for `/reset` / `/clear` and for compaction reseed). Acks with `{"type":"ready","id":"8"}`. |

Events are the same vocabulary as `--generate` (`delta` / `result` / `error`) plus
`ready` for a reset ack, each with the optional `id`:

```json
{"type":"ready","id":"8"}
{"type":"delta","id":"7","text":"…"}
{"type":"result","id":"7","content":"…"}
{"type":"error","id":"7","code":"contextWindowExceeded","message":"…"}
```

A turn `error` is reported **per-turn** and does not end the session — the loop
keeps running for the next command (`contextWindowExceeded` lets the Node side
compact, `reset`, and retry). Only stdin EOF (or a fatal read error) stops it.

## Notes

- The protocol is intentionally uniform: one-shot, streaming, and (future) chat
  all use the same event vocabulary, so adding a persistent-session mode (AF-3)
  needs no new wire types.
- `protocol.ts` implements the Node side of every line above and is unit-tested
  directly; `tests/fixtures/stub-helper.js` is a reference implementation of this
  document used by the test suite.
