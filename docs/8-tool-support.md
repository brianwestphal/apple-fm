# 8. Tool Calling (FR-14 / AF-5)

Investigation + design for letting the on-device model **call tools** mid-generation
— bash, file read, web search, and an **extensible** set defined by the caller —
with a **permission** gate on each call. Tracked by **FR-14** in
[3-requirements.md](3-requirements.md); investigated under **AFM-30**.

> **Status: Design only (investigated, not built).** This document is the outcome
> of the AFM-30 investigation: it establishes that the feature is feasible with
> Apple's native tool-calling API, lays out the architecture and the protocol
> extension, and slices the build into follow-up tickets. No code has shipped yet.

## The question (AFM-30)

> Other chat programs have support for tools and permission checking — could we add
> that to apple-fm? Tool examples: **bash**, **web-search / web**, **read** — and
> ideally an **extensible** set.

Short answer: **yes, and the framework does most of the heavy lifting.**
FoundationModels has first-class tool calling built in; the work for apple-fm is to
expose it across the existing Node ⇄ Swift boundary and add a permission layer.

### Competitive context: Apple's own `fm` CLI has no tools

macOS 27 (WWDC26) ships an **official** `fm` command-line tool preinstalled — it
overlaps heavily with apple-fm (`fm respond` ≈ `generate`, `fm chat`, `fm schema` ≈
`--schema`). But as of WWDC26 the `fm` CLI surface is **respond / chat / schema**
only (flags `--model pcc`, `--image`, `--schema`, `--instructions`); **tool calling
is deliberately left out of the terminal surface** and exposed only through the
Swift framework and the new Python SDK. So a permission-gated, extensible tool layer
in apple-fm's `chat` is a **genuine differentiator** vs. the system `fm` command, not
redundant with it.

> **Re-check this.** Apple's CLI is new and pre-1.0; it may gain tools (or other
> surface — `--image`, Private Cloud Compute routing) before or after macOS 27's GA.
> If `fm` adds tool calling, this differentiator argument weakens and the design
> should be revisited. Re-evaluate when this timestamp is over a month old, then
> bump it (see the re-eval note in [CLAUDE.md](../CLAUDE.md)).
>
> **Last checked: 2026-06-23 (WWDC26)** — `fm` CLI exposes **no tools**; surface is
> `respond` / `chat` / `schema` only. Tool calling is Swift-framework- and
> Python-SDK-only.

## Does FoundationModels support tools natively? Yes.

The framework defines a `Tool` protocol and a `LanguageModelSession(tools:)`
initializer. The model decides *if and when* to call a tool; the framework runs the
**entire tool-call loop automatically** inside the same `respond` / `streamResponse`
await — it generates the arguments, invokes the tool, feeds the output back into the
model, and continues until the model produces its final answer.

```swift
protocol Tool: Sendable {
    associatedtype Arguments: ConvertibleFromGeneratedContent   // a @Generable type
    associatedtype Output: PromptRepresentable
    var name: String { get }
    var description: String { get }
    var parameters: GenerationSchema { get }                    // arg schema
    func call(arguments: Arguments) async throws -> Output
}

let session = LanguageModelSession(tools: [BashTool(), ReadTool()], instructions: …)
let answer  = try await session.respond(to: prompt)            // tools fire inside
```

Two facts make this a clean fit for apple-fm:

1. **`call` is `async`.** The helper can *suspend* a tool invocation — awaiting a
   continuation — while the real work happens elsewhere, then resume when the result
   arrives. That "elsewhere" is the Node layer.
2. **`parameters` is a `GenerationSchema`**, which apple-fm already builds
   **dynamically** from a JSON Schema (`GuidedGeneration.swift` `compileSchema`,
   FR-8). So a tool's argument schema does not need to be known at Swift
   compile time — it can be sent from Node at runtime.

Together these mean we never write a Swift `Tool` per capability. We write **one
generic Swift adapter** that represents any Node-defined tool.

## The architectural challenge

apple-fm's layering (see [CLAUDE.md](../CLAUDE.md), [2-architecture.md](2-architecture.md))
puts the model in the Swift helper and *everything else* — typed logic, tests, the
zero-dependency Node surface — in `src/`. The tools the user asked for belong on the
Node side:

- **bash / read / web** are I/O and policy, not model code. Implementing them in
  Swift would bloat the helper, duplicate logic that's easier to test in TypeScript,
  and scatter the permission decision away from where the user-facing UX lives.
- Permission prompts, the allow/deny policy, and the REPL display all already live in
  Node (`repl.ts`).

So the model (Swift) must call a tool whose implementation lives in Node. The
invocation has to **round-trip across the NDJSON boundary** mid-generation.

```
model wants a tool ──▶ Swift Tool.call() suspends
                          │  emits  {"type":"tool_call", …}      (helper → Node)
                          ▼
                       Node executes the tool  (after a permission check)
                          │  writes {"type":"tool_result", …}    (Node → helper)
                          ▼
                       Swift continuation resumes ──▶ Output fed back to the model
                          │  model continues, may call more tools, then answers
                          ▼
                       {"type":"result", …}
```

This is the inverse of every existing event: until now Node sends a request and the
helper streams back. Tool calling adds a **helper→Node request** (`tool_call`) and a
**Node→helper response** (`tool_result`) *in the middle of a turn*. The
`--session` mode is already a bidirectional, long-lived, id-correlated stream, so the
plumbing exists — we extend its vocabulary.

## Design: one generic Swift adapter + a Node tool registry

### Swift side — `DynamicTool`

A single `struct DynamicTool: Tool` constructed from a wire tool definition
`{name, description, parameters}` sent by Node:

- `name` / `description` — passed through verbatim.
- `parameters` — compiled from the definition's JSON Schema via the existing
  `compileSchema` (FR-8).
- `Arguments` = `GeneratedContent` (the framework's generic generated value); we do
  **not** decode into a Swift type, we re-serialize the generated arguments to JSON
  and ship them to Node.
- `call(arguments:)` — emits a `tool_call` event tagged with a fresh **call id** and
  `await`s a continuation registered under that id. When Node's `tool_result` for
  that id arrives, the helper resumes and returns the result string as the tool
  `Output` (a `PromptRepresentable`). A `tool_error` result resumes by `throw`ing,
  which the framework surfaces to the model as a failed tool call.

The session is built with `LanguageModelSession(tools: defs.map(DynamicTool.init), …)`.
Tool definitions arrive on the **turn command** (or `reset`), so the available tool
set can change per turn.

### Node side — `ToolRegistry` + executor

- A `Tool` interface in `src/tools/`:
  ```ts
  interface Tool {
    name: string;
    description: string;
    parameters: JSONSchema;                 // reuses the FR-8 schema subset
    run(args: unknown, ctx: ToolContext): Promise<string>;
  }
  ```
- A `ToolRegistry` that holds enabled tools and emits their `{name, description,
  parameters}` definitions onto each turn command.
- A **tool dispatcher** in `liveSession.ts`: when a `tool_call` event arrives, look up
  the tool, run the **permission check** (below), `await tool.run(args, ctx)`, and
  write back `{"type":"tool_result","callId":…,"content":…}` (or `tool_error`).
- The dispatcher must run **concurrently with the in-flight turn** — the turn's
  `result` won't arrive until the tool resolves, so the read loop has to service
  `tool_call` events while still awaiting `result`. (The id-correlation machinery
  already lets multiple event kinds interleave on one stream.)

Built-in tools ship in `src/tools/builtin/` (one file each); the registry is the
extensibility seam — a library consumer registers their own `Tool` objects, a CLI
user enables built-ins by flag.

## Protocol extension

Additive to [4-protocol.md](4-protocol.md). New on the `--session` (and, if we want
one-shot tools, `--generate`) wire:

**Turn command gains an optional `tools` array:**
```json
{"id":"7","prompt":"…","tools":[
  {"name":"bash","description":"Run a shell command","parameters":{…JSON Schema…}}
]}
```

**New helper→Node event** (a tool the model invoked, mid-turn):
```json
{"type":"tool_call","id":"7","callId":"7:1","name":"bash","arguments":{"command":"ls"}}
```

**New Node→helper command** (the tool's outcome, resuming the suspended call):
```json
{"type":"tool_result","callId":"7:1","content":"a.txt\nb.txt\n"}
{"type":"tool_error","callId":"7:1","message":"permission denied"}
```

- `callId` is unique per invocation within a turn (`"<turnId>:<n>"`), distinct from the
  turn `id`, because one turn may spawn several tool calls.
- Everything stays single-process and serial *except* that a `tool_call`/`tool_result`
  exchange is nested inside an open turn. No new modes; `--probe` / `--generate` /
  `--session` are unchanged for callers that pass no `tools`.

## Permission model

The user explicitly asked for "permission checking." Mirror the mental model of other
agent CLIs, kept entirely in Node (the helper never decides policy):

- **Per-call gate.** Before `tool.run`, the dispatcher consults a `PermissionPolicy`:
  `ask` (default — prompt the user), `allow` (auto-approve), or `deny`.
- **Granularity.** Policy is keyed by tool name, and a tool may expose a finer key
  (e.g. bash by command prefix, read by path glob) so "always allow `git status`"
  is possible without "always allow all bash."
- **Interactive prompt.** In the REPL, a `tool_call` pauses the turn and asks
  `Run bash: \`ls\`? [y/N/a(lways)]`. Non-interactive (`generate`, piped) defaults to
  **deny unless pre-authorized** via flag/config — never silently run bash from a
  script.
- **Session memory.** "Always" answers persist for the process lifetime (and
  optionally to a config file).
- A denied call returns `tool_error` → the model is told the tool was refused and can
  continue without it.

This keeps the **dangerous-by-default** tools (bash, write-capable file ops) behind an
explicit, visible gate, consistent with the project's "confirm outward-facing or
hard-to-reverse actions" stance.

## Built-in tools — and an important tension

| Tool | Sketch | Notes |
| --- | --- | --- |
| `read` | read a file (path, optional line range) | Low-risk; still path-gated by policy. |
| `bash` | run a shell command, capture stdout/stderr/exit | **High-risk** — `ask`/deny by default, timeout-bounded, no shell-injection of args. |
| `web` / `web-search` | fetch a URL / run a search | **Breaks NFR-1.** |

**`web` conflicts with a core guarantee.** [3-requirements.md](3-requirements.md)
**NFR-1** is "on-device only; no network, no API key" — a headline property of
apple-fm (the *model* never phones home). A web tool sends the user's machine to the
network. That's still *defensible* (the model stays on-device; only an explicitly
enabled, permission-gated tool reaches out), but it must be:

- **opt-in and off by default**, never bundled silently;
- **documented** as the one place apple-fm touches the network, with NFR-1 reworded
  to "the *model* runs fully on-device; network access happens only through
  explicitly enabled tools";
- ideally implemented so the **zero-runtime-dependency** rule holds (Node ≥ 18 has
  global `fetch`, so a basic `web` fetch needs no dependency; a real *search* needs an
  API/endpoint and is the harder, more opinionated piece — likely a separate ticket).

This is the one genuine **decision for the user**, captured as an open question below.

## CLI / API surface

- **Library:** `ChatSession` / `LiveSession` gain an optional `tools: Tool[]` (and a
  `permission` policy). Fully programmatic — a consumer registers their own tools.
- **CLI:** `chat --tools bash,read` (or `--tool` repeated) enables built-ins;
  `--allow-tool bash` / `--deny-tool web` set policy; a REPL `/tools` command lists
  what's enabled. `--yes` pre-authorizes for non-interactive runs.
- One-shot `generate` *can* support tools too, but the interactive `chat` path is the
  natural first target (permission prompts need a human).

## Testing

Per the project's double-coverage rule:

- **Unit (device-free):** extend `tests/fixtures/stub-helper.js` to emit a `tool_call`
  for a sentinel prompt and consume `tool_result`, so the Node dispatcher,
  registry, and permission policy are tested end-to-end against the protocol without a
  device. Test each built-in tool's `run` in isolation (mock fs / child_process /
  fetch). Test the policy matrix (ask/allow/deny, prefix/glob keys, "always" memory).
- **E2E (device-free):** drive the real CLI (`tests/e2e/cli.e2e.test.ts` pattern) with
  the stub helper through a full tool round-trip incl. a permission prompt and a
  denial.
- **On-device smoke (AF-2):** confirm the real model actually invokes a `DynamicTool`,
  the continuation resumes, and the answer reflects the tool output.

## Phased implementation plan (follow-up tickets)

1. **Protocol + generic plumbing** — `DynamicTool` (Swift), `tool_call`/`tool_result`
   on the wire, Node dispatcher + concurrent read loop, stub-helper support. One
   trivial built-in (`read`) to prove the round-trip.
2. **Permission layer** — `PermissionPolicy`, REPL prompt, CLI flags, "always" memory,
   non-interactive deny-by-default.
3. **`bash` tool** — the high-risk built-in, behind permissions, timeout-bounded,
   safe arg handling.
4. **`web` tool** — gated on the NFR-1 decision; opt-in, documented, dependency-free
   fetch first; search later.
5. **Docs + AI summaries** — promote FR-14 from Deferred → Shipped per phase; update
   [4-protocol.md](4-protocol.md), [2-architecture.md](2-architecture.md), and the AI
   summaries.

## Open questions / decisions

- **NFR-1 vs. a `web` tool** — *the* call for the user: do we allow an opt-in,
  permission-gated network tool and reword NFR-1, or keep apple-fm strictly
  network-free and ship only `read`/`bash`? (Tracked on the phase-4 ticket.)
- **One-shot tools?** Do we want tools on `generate`, or keep them chat-only where a
  human can approve them? (Leaning chat-only first.)
- **Streaming + tools** — confirm `streamResponse` interleaves tool calls cleanly with
  `delta`s on-device; the design assumes the framework pauses the stream across a
  tool call. Needs on-device verification (AF-2).
- **Parallel tool calls** — the framework may request several at once; the dispatcher
  should handle concurrent `callId`s, but first cut can serialize.
- **Persistence of "always" grants** — process-lifetime only, or a written config?

## Sources

- [Deep dive into the Foundation Models framework — WWDC25 (Apple)](https://developer.apple.com/videos/play/wwdc2025/301/)
- [Teaching LLMs to Act: Mastering Tool Calling in FoundationModels](https://medium.com/@luizfernandosalvaterra/teaching-llms-to-act-mastering-tool-calling-in-foundationmodels-9bf319c081b2)
- [LLMs Calling LLMs: Building AI Agents with Apple's Foundation Models and Tool Calling](https://www.natashatherobot.com/p/ai-agents-apples-foundation-models-tool-calling)
- [The Ultimate Guide To The Foundation Models Framework — AzamSharp](https://azamsharp.com/2025/06/18/the-ultimate-guide-to-the-foundation-models-framework.html)
