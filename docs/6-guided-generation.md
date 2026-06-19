# 6. Native Guided Generation (FR-8 / AF-1)

Design + requirements for replacing the old prompt-guided `--schema` with Apple's
native guaranteed-structure generation. Tracked by **FR-8** in
[3-requirements.md](3-requirements.md); designed under **AFM-11**, implemented
under **AFM-15**.

> **Status: Shipped.** `apple-fm-helper` compiles the request JSON Schema to a
> `DynamicGenerationSchema` / `GenerationSchema` (`compileSchema` /
> `dynamicSchema`) and calls `respond(to:schema:)`; smoke-verified on-device for
> object / string / enum / integer / number / boolean / array / nesting. The notes
> below are the design; the "Supported subset" and "constraints" sections record
> what actually ships.

## Previously (FR-7, prompt-guided)

`--schema` *used to be* prompt-guided: `apple-fm-helper/main.swift` injected the
JSON Schema into the model's instructions and returned the model's JSON **text**, which
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

**Constraints (as shipped):**

- **Array `minItems` / `maxItems`** → `DynamicGenerationSchema(arrayOf:minimumElements:maximumElements:)` — **enforced**.
- **Integer / number `minimum` / `maximum`** → a `GenerationGuide` range (or open
  bound) on the primitive — **enforced**. A `minimum > maximum` schema is rejected
  with `unsupportedSchema` (the `ClosedRange` would otherwise be invalid).
- **String `pattern`** → **not enforced.** A `GenerationGuide.pattern(regex)` was
  tried but the on-device model's constrained decoding **errors at generation
  time** on a regex guide (`GenerativeError 1020000`), which would break *every*
  schema carrying a `pattern`. So `pattern` is accepted and ignored.
- **Other value constraints** (`minLength` / `maxLength`, `format`,
  `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf`, …) are **accepted but not
  enforced**. Structure is always guaranteed; these bounds are best-effort.

The stance is deliberate: reject only what can't be *structurally* produced;
silently honor value bounds where a guide works, and don't reject a schema just
because a value bound isn't enforced (that would break common, otherwise-valid
schemas).

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
- **`schema` + `stream`** streams `snapshot` events — the **full current partial
  JSON** each time (replace, not append), since structured partials are not
  append-only (AFM-16). The final `result` carries the complete JSON.

## Implementation surface

- **`apple-fm-helper/main.swift`** — translate the request JSON Schema into a
  `DynamicGenerationSchema` / `GenerationSchema`; call `respond(to:schema:)` (or
  `streamResponse(to:schema:)` + `snapshot` events when streaming); serialize
  `GeneratedContent` → JSON. Throw a structured error for unsupported constructs
  (→ `unsupportedSchema`).
- **`src/helper.ts` / `src/protocol.ts`** — pass-through; `parseEvent` handles the
  `snapshot` event and `generate` forwards it to an optional `onSnapshot`. Node
  stays thin and does **not** re-validate the schema (the helper is authoritative).
- **`tests/fixtures/stub-helper.js`** — emulate: a supported schema returns
  schema-shaped JSON (snapshots then result when streaming); an unsupported one
  emits `unsupportedSchema`. Keeps the suite device-free.
- **Docs** — flip FR-7 → Shipped (native) and FR-8 → Shipped in
  [3-requirements.md](3-requirements.md) + [ai/requirements-summary.md](ai/requirements-summary.md);
  update the `schema` row in [4-protocol.md](4-protocol.md).

## Testing

- Unit (device-free, stub): supported schema → valid JSON; unsupported construct →
  `unsupportedSchema`; `schema`+`stream` → `snapshot` events then the final result;
  error-code mapping in `helper.ts`.
- On-device smoke (AF-2): `respond(to:schema:)` returns conforming JSON for a
  representative nested object/array/enum schema.

## Resolved during implementation

- `DynamicGenerationSchema` exposes object / `anyOf [String]` (enum) / `arrayOf`
  (with `minimumElements` / `maximumElements`) / primitive (`init(type:guides:)`
  for `String` / `Int` / `Double` / `Bool`) constructors; `GeneratedContent` has
  `jsonString` for serialization.
- `GenerationGuide` numeric `minimum` / `maximum` / `range` **work** and are wired
  up (AFM-19). The string `pattern` guide does **not** — `respond(to:schema:)`
  fails with `GenerativeError 1020000` whenever a regex guide is present — so
  `pattern` is left unenforced. (Verified on-device.)

## Follow-up tickets

- **AFM-16** (done) — structured streaming: `schema` + `--stream` emits full-JSON
  `snapshot` events (replace), since structured partials aren't append-only.
- **AFM-19** (done) — numeric `minimum` / `maximum` enforcement. `pattern` and the
  remaining value constraints stay best-effort (see Constraints above); revisit
  `pattern` if a future model accepts regex guides.
