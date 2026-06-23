# 9. Tool Calling

Requirements for **tool calling** in apple-fm: letting the on-device model call an
**extensible**, **permission-gated** set of Node-side tools (read / bash / web)
mid-generation. This is the requirements view; the architecture and rationale are in
the investigation/design doc [8-tool-support.md](8-tool-support.md). Tracked by
**FR-14** in [3-requirements.md](3-requirements.md); the build is phased under
**AF-5** (tickets AFM-31…34).

> **Status: phase 1 shipped.** The generic round-trip plumbing (protocol, Swift
> `DynamicTool`, Node `ToolRegistry` + dispatcher) and the `read` built-in are
> implemented, unit + e2e tested device-free, and **smoke-verified on-device** (the
> real model called `read`, the file content round-tripped, and the answer reflected
> it). Permissions (phase 2), `bash` (phase 3), and `web` (phase 4) are not built —
> see the status table below.

## What it is

The model decides *when* to call a tool; the Swift helper runs the framework's
tool-call loop and **round-trips each invocation to Node** over NDJSON, where the
tool's implementation (and, from phase 2, the permission check) lives. Only the Node
layer ever implements a tool — the helper just carries the call across the wire. One
generic Swift `DynamicTool` represents *any* Node-defined tool, so new tools are pure
TypeScript.

## Requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| TC-1 | Generic tool round-trip across the Node ⇄ Swift boundary | **Shipped** (phase 1) | `tool_call`/`tool_result`/`tool_error` extend the `--session` protocol ([4-protocol.md](4-protocol.md)); Swift `DynamicTool` (`apple-fm-helper/Tools.swift`) suspends on `call` and resumes on the reply; the Node dispatcher (`liveSession.ts`) services `tool_call` concurrently with the in-flight turn. Bound at `reset`. **On-device verified.** |
| TC-2 | Extensible tool registry (library + CLI) | **Shipped** (phase 1) | `ToolRegistry` (`src/tools/`) is the seam: a library consumer registers their own `Tool`; the CLI enables built-ins with `chat --tools <names>` (`registryFromNames`). |
| TC-3 | Tool argument schemas constrain the model | **Shipped** (phase 1) | A tool's `parameters` JSON Schema is compiled to a native `GenerationSchema` (reuses FR-8), so the model can only generate valid arguments. |
| TC-4 | `read` built-in tool | **Shipped** (phase 1) | `src/tools/builtin/read.ts`: read a UTF-8 file, optional line `offset`/`limit`. Read-only; auto-runs in phase 1 (no gate yet). |
| TC-5 | Per-call permission policy (`ask`/`allow`/`deny`) | **Deferred** (phase 2, AFM-32) | Kept in Node; keyed by tool name with finer keys (bash by command prefix, read by path glob); REPL `[y/N/a]` prompt; **deny-by-default when non-interactive**. |
| TC-6 | `bash` built-in tool | **Deferred** (phase 3, AFM-33) | High-risk; behind TC-5; timeout-bounded; safe arg handling. |
| TC-7 | `web` built-in tool (fetch + search) | **Deferred** (phase 4, AFM-34) | **Breaks NFR-1** (network). Approved by the user *provided it is permission-gated*; off by default, documented as the one networked tool. User chose **fetch + a search backend** (search needs an external endpoint/key — likely its own follow-up). NFR-1 to be reworded then. |
| TC-8 | Surface tool activity to the user | **Deferred** (phase 2+) | The REPL should show which tool ran with what arguments (today the round-trip is silent except for the final answer). |

## Phase 1 surface (shipped)

- **Protocol** ([4-protocol.md](4-protocol.md)): `reset.tools[]`; events `tool_call`;
  commands `tool_result` / `tool_error`; `callId` = `"<turnId>:<n>"`.
- **Swift** (`apple-fm-helper/Tools.swift` + `main.swift`): `DynamicTool`, the
  `ToolBridge` actor (suspend/resume), and a concurrent session reader so a
  `tool_result` is delivered while a turn is suspended.
- **Node** (`src/tools/`): `Tool` / `ToolContext` / `ToolDefinition` types,
  `ToolRegistry`, `registryFromNames`, the `read` built-in, and the dispatcher in
  `liveSession.ts` (with a per-turn timeout restart across tool calls).
- **Public API** (`src/index.ts`): `Tool`, `ToolContext`, `ToolDefinition`,
  `ToolRegistry`, `registryFromNames`, `readTool`, `BUILTIN_TOOLS`.
- **CLI**: `apple-fm chat --tools read` (`cliArgs.ts` → `cli.ts` → `repl.ts`).

## Design decisions

- **Tools bind at `reset`, not per turn.** The framework binds tools at session
  construction, so definitions ride on `reset`. `ChatSession` always resets before the
  first turn, so this is reliable; changing the tool set means a reset (a new session).
- **One generic adapter.** `DynamicTool.Arguments = GeneratedContent` and the
  arguments are re-serialized to JSON (`GeneratedContent.jsonString`) for Node — so no
  Swift type per tool.
- **A failed tool is recoverable.** `tool_error` is fed to the model (it can continue),
  not a turn-ending crash. An unknown/unsupported tool degrades gracefully (skipped
  with a diagnostic; dispatcher returns a `tool_error`).
- **Phase-1 `read` auto-runs.** Acceptable because `read` is read-only; the permission
  gate (TC-5) lands before `bash`/`web`, which are unsafe without it.

## Testing

- **Unit** (`tests/tools.test.ts`): `ToolRegistry`, `registryFromNames`, the `read`
  tool (whole file / range / bad args / missing path).
- **Integration, device-free** (`tests/liveSession.test.ts`): a real `LiveSession`
  against the stub helper drives a full `tool_call → run → tool_result` round-trip,
  a `tool_error`, session-survival after a tool turn, and the not-offered path. The
  stub's `TOOL <name> <jsonArgs>` sentinel mirrors the Swift suspend/resume.
- **E2E, device-free** (`tests/e2e/cli.e2e.test.ts`): `apple-fm chat --tools read`
  reads a fixture through the assembled CLI; an unknown `--tools` name exits 1.
- **On-device** (AF-2): manually smoke-verified in phase 1 (the model called `read`
  and used the result). An automated on-device test remains AF-2.

## Open items

- Permissions, `bash`, `web` (TC-5…7) — phases 2–4.
- Tool-activity display (TC-8).
- `web` search backend choice + NFR-1 rewording (rides on phase 4).
- A slow tool restarts the turn timeout per call; a global cap on total tool time is
  not yet enforced.
