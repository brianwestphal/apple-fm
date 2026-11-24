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
| PERM-2 | Rules keyed by tool, or by a finer `tool:key` | **Shipped** | A bare `tool` rule matches any call; a keyed rule matches per the tool's `matchKey(ruleKey, callKey, kind)` — **exact equality by default** (never a prefix). `read` widens it to a *resolved path boundary* (a dir grant covers descendants, `..` and name-prefix siblings excluded); `bash` keeps `allow` exact but makes `deny` a broad best-effort token match. Key comes from `permissionKey(args)`. A keyed rule does **not** allow the whole tool. (AFM-63 / AFM-67.) |
| PERM-3 | Prompt the user on `ask` | **Shipped** | The REPL shows `Run <description>? [y/N/a(lways)]`. `y` allows once, `a` allows subsequent matching calls, and any other response denies. The terminal shows one pending request at a time in arrival order. Cancellation and EOF dismiss unanswered requests. The displayed description is sanitized and length-capped. |
| PERM-4 | "Always" persists for the process lifetime | **Shipped** | An `always` answer adds an allow rule (keyed to that call) for the rest of the run. Not yet persisted to disk (open item). |
| PERM-5 | Non-interactive ⇒ deny unless pre-authorized | **Shipped** | No asker (piped / not a TTY) ⇒ `ask` denies. A script never silently runs a tool. Pre-authorize with `--allow-tool` / `--yes`. |
| PERM-6 | A refusal lets the model continue | **Shipped** | A denied/failed call is fed back as the tool **result** (a message), not a throwing `tool_error` — on-device a thrown tool error aborts the whole turn (see below). The model reads the message and carries on. |
| PERM-7 | CLI control | **Shipped** | `--allow-tool <rule>` / `--deny-tool <rule>` (repeatable; `tool` or `tool:keyPrefix`), `--yes` (approve all), and the `/tools` REPL command. |
| PERM-8 | Programmatic control | **Shipped** | `new PermissionPolicy({ default, allow, deny, asker })`, passed to `ChatSession` / `LiveSession` via `permission`. Exported from `apple-fm`. |
| PERM-9 | Persist "always" grants to config | **Deferred** | Process-lifetime only today; a written allowlist is a possible follow-up. |
| PERM-10 | A permissive default never blanket-approves a `dangerous` tool | **Shipped** | A tool may set `dangerous: true` (`bash`). When the *default* is `allow` (`--yes`), a dangerous tool still `ask`s — so `--yes` can't silently hand the untrusted model arbitrary command execution, interactively or piped. An explicit `--allow-tool bash` still grants it. (AFM-64.) |

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
apple-fm chat --tools read --allow-tool read:/srv   # pre-approve reads under /srv (and only under it)
apple-fm chat --tools bash --allow-tool "bash:git status"  # pre-approve exactly `git status`
apple-fm chat --tools bash --deny-tool bash:rm      # best-effort block of commands invoking rm
apple-fm chat --tools read,bash --yes               # auto-approve read; bash still prompts
apple-fm chat --tools bash --yes --allow-tool bash  # …add this to also auto-approve bash (use with care)
```

In the REPL, `/tools` lists the enabled tools.

## Testing

- **Unit** (`tests/permissions.test.ts`): the decide matrix (default, allow, deny,
  deny-wins, exact keyed matching, bare-vs-keyed), the tool-specific matchers via the
  registry (bash exact-allow / best-effort-deny, read path-boundary + `..`-escape,
  the `--yes` dangerous downgrade), `sanitizeForPrompt` (newline/ANSI/length), `authorize`
  (allow/deny without prompting, ask-with-no-asker denies, once vs always, "always"
  memory + read descendant extension, asker-throws ⇒ deny), and the REPL `readlineAsker`
  answer parsing. Per-tool `matchKey`/`dangerous` also in `tests/tools.test.ts` (read)
  and `tests/bash.test.ts` (bash + the output-limit kill).
- **Integration** (`tests/liveSession.test.ts`): the gate in the dispatcher — allowed
  runs, denied is refused (tool never runs, refusal fed back), non-interactive denies,
  asker approval runs.
- **E2E** (`tests/e2e/cli.e2e.test.ts`): `--allow-tool` / `--yes` allow; piped (no TTY)
  denies; `--deny-tool` beats `--yes`; `/tools` lists tools.
- **On-device** (AF-2): allowed `read` returns the file; denied `read` → the model
  reports it couldn't access the file (verified manually in the AFM-32 session).

## Hardening (AFM-63 / 64 / 67 / 68)

An adversarial review (treating the on-device model as untrusted) tightened the gate:

- **Exact-match grants for `bash`** (AFM-63): an `allow` rule / "always" no longer
  matches by *prefix*, so approving `ls` can't be extended to `ls; curl … | sh`.
- **Path-boundary grants for `read`** (AFM-63): `matchKey` resolves `..` and requires a
  separator boundary, so a directory grant can't be traversed out of or leaked to a
  name-prefix sibling. It resolves the **real** path (following symlinks), so a symlink
  inside an approved directory that points outside it is rejected, not read (AFM-76).
- **`--yes` never covers a `dangerous` tool** (AFM-64, PERM-10 above).
- **Best-effort `deny` for `bash`** (AFM-67): a deny matches the token at a word/path
  boundary anywhere in the command (catching `/bin/rm`, `command rm`) — explicitly *not*
  a security guarantee; the real control is not enabling `bash`.
- **Sanitized prompt** (AFM-68, PERM-3 above): the model-controlled description is
  stripped of control chars / ANSI and length-capped before display.

## Safe-by-default gate (AFM-78)

The gate is only as safe as its default. When a `LiveSession` / `ChatSession` is given
`tools` but **no** `permission` policy, the default backend installs a **fail-closed**
policy (default `ask`, no asker ⇒ every tool call denied) rather than running tools
ungated — so a `tool_call`, including one emitted by a compromised/replaced helper,
never runs without an explicit decision. Letting tools run is a deliberate choice: pass
a policy with `allow` rules, an interactive `asker`, or `{ default: 'allow' }` (a
`dangerous` tool still needs an explicit allow — AFM-64). The CLI was always safe
(`repl.ts` builds a policy whenever `--tools` is set); this closes the **library-API**
footgun where omitting the policy meant ungated execution.

## Open items

- Persist "always" grants (PERM-9).
- Surface tool activity / the granted decision in the REPL transcript (TC-8 in
  [9-tool-calling.md](9-tool-calling.md)).
