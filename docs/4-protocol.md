# 4. Wire Protocol

The Node layer and the Swift helper communicate over **line-delimited JSON
(NDJSON)** on stdin/stdout. The helper has two modes, selected by a flag.

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
- `schema`, when present, requests structured output (see FR-7/FR-8 in
  [3-requirements.md](3-requirements.md)).

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

`badRequest`, `unavailable`, `contextWindowExceeded`, `guardrailViolation`,
`generationError`, `inferenceFailed`. The Node layer raises these as thrown
errors (`[code] message`); `ChatSession` may act on `contextWindowExceeded` by
compacting and retrying (AF-3).

## Notes

- The protocol is intentionally uniform: one-shot, streaming, and (future) chat
  all use the same event vocabulary, so adding a persistent-session mode (AF-3)
  needs no new wire types.
- `protocol.ts` implements the Node side of every line above and is unit-tested
  directly; `tests/fixtures/stub-helper.js` is a reference implementation of this
  document used by the test suite.
