# 10. Tool Permissions

Requirements for the **per-call permission policy** that gates tool calling
(FR-14 / AF-5 **phase 2**). This is the "permission checking" the original request
(AFM-30) asked for. It builds on [9-tool-calling.md](9-tool-calling.md) (the tool
round-trip) and is tracked as **TC-5** there; this doc is the focused requirements
view of the gate itself. Implemented under **AFM-32**.

> **Status: shipped + on-device verified.** Every tool call is checked before it
> runs; a refusal is fed back to the model as the tool's result so it continues
> gracefully. Verified against the real model: an allowed `read` returns the file;
> a denied `read` makes the model tell the user it couldn't access the file (no leak,
> no turn abort).

## Why

Tools let the on-device model touch the user's machine (read files; soon run shell
commands and reach the network). That must be **gated** — the user decides what runs.
The policy lives entirely in Node (`src/tools/permissions.ts`); the Swift helper never
makes a policy decision.

## Requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| PERM-1 | Decide `allow` / `deny` / `ask` per call | **Shipped** | `PermissionPolicy.decide`. Default `ask`. **Deny wins** over allow. |
| PERM-2 | Rules keyed by tool, or by a finer `tool:keyPrefix` | **Shipped** | A keyed rule matches when the call's key *starts with* the prefix (e.g. a `bash:git` rule, or `read:/home/me`). A keyed rule does **not** allow the whole tool. The key comes from the tool's optional `permissionKey(args)` (`read` → the path). |
| PERM-3 | Prompt the user on `ask` | **Shipped** | The REPL shows `Run <description>? [y/N/a(lways)]`; `y` = once, `a` = always, anything else = deny. `describe(args)` supplies the text (`read /etc/hosts`). |
| PERM-4 | "Always" persists for the process lifetime | **Shipped** | An `always` answer adds an allow rule (keyed to that call) for the rest of the run. Not yet persisted to disk (open item). |
| PERM-5 | Non-interactive ⇒ deny unless pre-authorized | **Shipped** | No asker (piped / not a TTY) ⇒ `ask` denies. A script never silently runs a tool. Pre-authorize with `--allow-tool` / `--yes`. |
| PERM-6 | A refusal lets the model continue | **Shipped** | A denied/failed call is fed back as the tool **result** (a message), not a throwing `tool_error` — on-device a thrown tool error aborts the whole turn (see below). The model reads the message and carries on. |
| PERM-7 | CLI control | **Shipped** | `--allow-tool <rule>` / `--deny-tool <rule>` (repeatable; `tool` or `tool:keyPrefix`), `--yes` (approve all), and the `/tools` REPL command. |
| PERM-8 | Programmatic control | **Shipped** | `new PermissionPolicy({ default, allow, deny, asker })`, passed to `ChatSession` / `LiveSession` via `permission`. Exported from `apple-fm`. |
| PERM-9 | Persist "always" grants to config | **Deferred** | Process-lifetime only today; a written allowlist is a possible follow-up. |

## How it works

The live-session dispatcher (`liveSession.ts`) consults the policy **before** running a
tool:

1. Build a `PermissionRequest` from the tool's `permissionKey` / `describe` hooks.
2. `policy.authorize(request)` → `decide` (allow/deny/ask). On `ask`, prompt via the
   injected `PermissionAsker`; with no asker, deny. An `always` answer is remembered.
3. Allowed → run the tool, return its output as the `tool_result`. Refused → return a
   "permission denied" message as the `tool_result`.

### Key on-device finding (drives PERM-6)

Throwing from the Swift `DynamicTool.call` (the `tool_error` wire path) makes
FoundationModels fail the **entire turn** with a `ToolCallError` — the model does
**not** get a chance to continue. So a denial or a tool failure is fed back as a
normal `tool_result` whose content explains what happened; the `tool_error` path
remains in the protocol but is effectively a *fatal* abort and is not used for
routine refusals.

## CLI

```
apple-fm chat --tools read                          # read is enabled; each call prompts
apple-fm chat --tools read --allow-tool read        # pre-approve all read calls
apple-fm chat --tools read --allow-tool read:/srv   # pre-approve reads under /srv
apple-fm chat --tools bash --deny-tool bash:rm      # never run bash commands starting "rm"
apple-fm chat --tools read --yes                    # approve everything (use with care)
```

In the REPL, `/tools` lists the enabled tools.

## Testing

- **Unit** (`tests/permissions.test.ts`): the decide matrix (default, allow, deny,
  deny-wins, keyed prefix matching, bare-vs-keyed), `authorize` (allow/deny without
  prompting, ask-with-no-asker denies, once vs always, "always" memory, asker-throws
  ⇒ deny), and the REPL `readlineAsker` answer parsing (y / yes / a / always / empty /
  other).
- **Integration** (`tests/liveSession.test.ts`): the gate in the dispatcher — allowed
  runs, denied is refused (tool never runs, refusal fed back), non-interactive denies,
  asker approval runs.
- **E2E** (`tests/e2e/cli.e2e.test.ts`): `--allow-tool` / `--yes` allow; piped (no TTY)
  denies; `--deny-tool` beats `--yes`; `/tools` lists tools.
- **On-device** (AF-2): allowed `read` returns the file; denied `read` → the model
  reports it couldn't access the file (verified manually in the AFM-32 session).

## Open items

- Persist "always" grants (PERM-9).
- Surface tool activity / the granted decision in the REPL transcript (TC-8 in
  [9-tool-calling.md](9-tool-calling.md)).
- `bash` (AFM-33) and `web` (AFM-34) will lean on this gate; `bash`'s `permissionKey`
  should be the command (prefix rules), `web`'s the host/URL.
