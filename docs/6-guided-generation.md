# 6. Native Guided Generation (FR-8 / AF-1)

Design + requirements for replacing today's prompt-guided `--schema` with Apple's
native guaranteed-structure generation. Tracked by **FR-8** in
[3-requirements.md](3-requirements.md); implementation is **AFM-11**.

## Today (FR-7, Partial)

`--schema` is *prompt-guided*: `apple-fm-helper/main.swift` injects the JSON
Schema into the model's instructions and returns the model's JSON **text**, which
the Node layer reparses. The model usually complies, but nothing **guarantees**
the output is valid against the schema — it can drift, wrap the JSON in prose, or
omit fields.

## Goal (FR-8)

Use `FoundationModels`' `DynamicGenerationSchema` to build a `GenerationSchema`
from the request's JSON Schema at runtime and call `respond(to:schema:)`, so the
framework **guarantees** the output conforms. The helper serializes the resulting
`GeneratedContent` back to a JSON string (the existing `result.content` shape).

## Decision: strict, not best-effort

When a request's JSON Schema uses a construct the native path **can't** express,
the helper **errors** — it does **not** silently fall back to prompt-guiding.
Rationale: the whole point of `--schema` becomes *guaranteed* structure; a silent
fallback would make the guarantee unreliable and invisible to the caller. A clear
error naming the offending construct lets the caller simplify the schema or accept
freeform `generate`.

This **replaces** FR-7: with native generation, `--schema` either returns
schema-valid JSON or fails with a structured error. (Prompt-guiding is not kept as
a fallback.)

## Supported JSON Schema subset (v1)

The helper maps a documented subset to `DynamicGenerationSchema`. Anything outside
it is rejected (see Errors). The exact constraint support must be **verified
against the macOS 26 SDK** during implementation; the intended mapping is:

| JSON Schema | Maps to | Notes |
| --- | --- | --- |
| `type: object` + `properties` + `required` | object schema with named properties | non-required properties become optional |
| `type: string` | string | |
| `type: string` + `enum` | string constrained to the choices | |
| `type: integer` / `type: number` | integer / number | |
| `type: boolean` | boolean | |
| `type: array` + `items` | array of the item schema | nested arrays/objects allowed |
| nested `object` / `array` | nested schema | arbitrary nesting depth |
| `description` (any level) | the schema element's natural-language guide | improves field semantics |

**Constraints** (`minimum`/`maximum`, `minItems`/`maxItems`, `pattern`, string
`format`, etc.) are mapped **only where `GenerationGuide` supports them**; the
implementation ticket must enumerate exactly which survive and which are rejected.

**Out of scope for v1 (reject):** `oneOf`/`allOf`/`anyOf` across object types,
`$ref`/`$defs`, `additionalProperties` schemas, tuple `items`, conditional
(`if`/`then`/`else`) — i.e. anything `DynamicGenerationSchema` can't model
directly.

## Wire protocol

No new request fields — `schema` already exists ([4-protocol.md](4-protocol.md)).
Changes:

- A new error code **`unsupportedSchema`** for a schema the native path can't
  express; `message` names the offending keyword/path.
- `result.content` is unchanged: the JSON string, now guaranteed valid against the
  schema.
- **`schema` + `stream` is rejected in v1** (`badRequest`). Structured *streaming*
  (partial objects via `streamResponse(generating:)`) is a separate follow-up.

## Implementation surface

- **`apple-fm-helper/main.swift`** — translate the request JSON Schema into a
  `DynamicGenerationSchema` / `GenerationSchema`; call `respond(to:schema:)`;
  serialize `GeneratedContent` → JSON. Throw a structured error for unsupported
  constructs (→ `unsupportedSchema`) and for `schema` + `stream`.
- **`src/helper.ts` / `src/protocol.ts`** — pass-through already exists; add
  `unsupportedSchema` to the error-code mapping/types. Node stays thin and does
  **not** re-validate the schema (the helper is authoritative).
- **`tests/fixtures/stub-helper.js`** — emulate: for a supported schema return
  schema-shaped JSON; for an unsupported one (and for `schema`+`stream`) emit the
  matching error. Keeps the suite device-free.
- **Docs** — flip FR-7 → Shipped (native) and FR-8 → Shipped in
  [3-requirements.md](3-requirements.md) + [ai/requirements-summary.md](ai/requirements-summary.md);
  update the `schema` row in [4-protocol.md](4-protocol.md).

## Testing

- Unit (device-free, stub): supported schema → valid JSON; unsupported construct →
  `unsupportedSchema`; `schema`+`stream` → `badRequest`; error-code mapping in
  `helper.ts`.
- On-device smoke (AF-2): `respond(to:schema:)` returns conforming JSON for a
  representative nested object/array/enum schema.

## Open questions

- Exact `GenerationGuide` constraint coverage on macOS 26 (drives the supported
  subset table) — resolve during implementation against the real SDK.
- Whether to expose structured **streaming** at all, or leave it out indefinitely.

## Follow-up tickets

Implementation is tracked separately so this doc can land first — see the tickets
created from AFM-11.
