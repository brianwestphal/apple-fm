# 11. Built-in Tools

Requirements for the **built-in tools** apple-fm ships for the model to call
(FR-14 / AF-5). The generic tool-calling mechanism is in
[9-tool-calling.md](9-tool-calling.md) and the permission gate in
[10-permissions.md](10-permissions.md); this doc is the per-tool requirements view —
what each built-in does, its arguments, and its safety properties.

> **Status:** `read` (phase 1, AFM-31), `bash` (phase 3, AFM-33), and `web` fetch
> (phase 4, AFM-34) shipped and on-device verified. A `web` **search** backend (TC-9)
> is a follow-up. Each tool is enabled with `chat --tools <name>` and gated by the
> permission policy.

Every built-in implements the `Tool` contract (`src/tools/types.ts`): `name`,
`description`, a JSON-Schema `parameters` (compiled to the model's argument schema,
FR-8), `run(args)`, and the optional `permissionKey(args)` / `describe(args)` hooks
that scope permission rules and the prompt. Registered in `BUILTIN_TOOLS`
(`src/tools/index.ts`); `registryFromNames` builds a registry from their names.

## `read` (`src/tools/builtin/read.ts`) — **Shipped**

| | |
| --- | --- |
| Purpose | Read a UTF-8 text file from the local filesystem. |
| Arguments | `path` (string, required); `offset` (int ≥ 0), `limit` (int ≥ 1) — an optional 0-based line range. |
| Result | The file contents (or the selected line range). |
| Permission key | the `path`, so a user can pre-approve a directory (`read:/home/me`). |
| Risk | Low (read-only) — but still gated; default policy is `ask`. |
| Errors | Missing path / unreadable file → the fs error is fed back to the model. |

## `bash` (`src/tools/builtin/bash.ts`) — **Shipped**

| | |
| --- | --- |
| Purpose | Run a shell command and return its exit code, stdout, and stderr. |
| Arguments | `command` (string, required). |
| Result | A status line (`exit code: N`, or a timeout / signal / failed-to-start note) plus `stdout:` / `stderr:` sections when non-empty. |
| Permission key | the `command`, so a user can pre-approve a prefix (`--allow-tool "bash:git "`). |
| Risk | **High** — arbitrary code execution. Default `ask`; **deny-by-default when non-interactive** (a script never silently runs a command unless `--allow-tool`/`--yes`). |

**Safety properties (BT-1…4):**

- **BT-1 No shell injection of model args.** The command is passed as a *single argv
  element* to `sh -c` (`spawn('/bin/sh', ['-c', command])`) — never concatenated into
  another shell string. The model's command is of course still executed by the shell
  (that is the tool's purpose); the gate is the permission prompt, not arg escaping.
- **BT-2 Timeout-bounded.** A command running past the timeout (default 30 s) is
  `SIGKILL`ed and reported as timed out, so a hang can't wedge the turn.
- **BT-3 Output-capped.** stdout and stderr are each capped (8 000 chars) with a
  "…(N more chars truncated)" note, so a runaway command can't blow the model's
  context window.
- **BT-4 Non-zero exit is a normal result.** A failing command reports its exit code
  (not a thrown error), so the model can react to it; only an empty command rejects.

## `web` (`src/tools/builtin/web.ts`) — **Shipped** (fetch)

| | |
| --- | --- |
| Purpose | Fetch an http(s) URL (GET) and return its main text content. |
| Arguments | `url` (string, required; must be `http(s)://`); `offset` (int ≥ 0) — a 0-based character offset to page a long page. |
| Result | A status line (`HTTP <code> <text> (<content-type>)`, `[from char N]` when paging) plus the body — HTML reduced to its main article body (readability-style; [12-web-extraction.md](12-web-extraction.md)), other content types as-is. |
| Permission key | the `url`, so a user can pre-approve a site (`--allow-tool "web:https://docs."`). |
| Risk | **Network.** The one apple-fm tool that leaves the machine — **off by default**, opt-in (`chat --tools web`), permission-gated; default `ask`, deny-by-default non-interactive. |

**Properties (WT-1…4):**

- **WT-1 The one networked tool.** apple-fm makes no network connection unless `web`
  is explicitly enabled *and* a call is approved. The *model* still runs fully
  on-device; only this tool reaches out. NFR-1 ([3-requirements.md](3-requirements.md))
  was reworded to reflect this.
- **WT-2 GET only, dependency-free.** Uses Node's global `fetch` (Node ≥ 18) — no new
  dependency. No request body / non-GET methods, so no remote side effects.
- **WT-3 Bounded + readable.** Timeout (15 s default, `AbortController`), and the
  returned text is windowed to a cap (default `MAX_TOOL_OUTPUT_CHARS` = 3 000 chars ≈
  750 tokens; AFM-38) so a large page can't overflow the ~4096-token on-device window.
  HTML is first reduced to its **main article body** with a readability-style heuristic
  (drop boilerplate, scope to `<main>`/`<article>`, keep content blocks, link-density
  filter, safe fallback) so the capped text is mostly real content — see
  [12-web-extraction.md](12-web-extraction.md) (WX-1…7; AFM-39). The model pages a long
  page with `offset`; a user can widen the cap with `APPLE_FM_WEB_MAX_CHARS`.
- **WT-4 HTTP errors are normal results.** A 4xx/5xx *status* is reported (not thrown)
  so the model can react; only a non-http(s) URL, a timeout, or a transport error
  rejects.

> **Search vs. fetch.** This is URL *fetch*. A real *web search* (a query → results)
> needs an external search API/endpoint + key/config and is a separate follow-up
> (TC-9 in [9-tool-calling.md](9-tool-calling.md)).

> **On-device reality.** Web reading is genuinely marginal on the ~3B / 4k-token
> on-device model: it works best for focused pages and APIs. AFM-39 added
> readability-style main-content extraction, paging (`offset`), and a configurable cap
> (`APPLE_FM_WEB_MAX_CHARS`) so the capped text is mostly real content (see
> [12-web-extraction.md](12-web-extraction.md)) — but big content-heavy pages are still
> bounded by the tiny window. Enabling fewer tools (`--tools web` alone) and asking
> about focused URLs works best.

## Testing

- **Unit**: `tests/tools.test.ts` (`read` + registry), `tests/bash.test.ts` (`bash`,
  real `/bin/sh`), `tests/web.test.ts` (`web`, injected `fetch` — HTML→text,
  readability extraction (article scoping, link-density filter, plain-strip fallback),
  paging (`offset`), configurable cap (`maxChars` + `APPLE_FM_WEB_MAX_CHARS`), non-HTML
  pass-through, error status, size cap, non-http reject, timeout, transport error,
  permission key) — all device-free.
- **E2E** (`tests/e2e/cli.e2e.test.ts`): `read` / `bash` run through the assembled CLI
  behind the gate (pre-authorized runs; piped-non-interactive denies); `web` is denied
  by default (no network reached).
- **On-device** (AF-2): the real model called `read` (returned a file's secret),
  `bash` (ran `echo SMOKE-$((6*7))` → `SMOKE-42`), and `web` (fetched a local page and
  reported its content).

## Adding a built-in

Implement `Tool` in `src/tools/builtin/<name>.ts`, add it to `BUILTIN_TOOLS`
(`src/tools/index.ts`), export it from the public API (`src/index.ts`), give it a
`permissionKey`/`describe` if calls should be gated more finely than the whole tool,
and a one-line `usageHint` (folded into the CLI's auto tool-use system prompt, AFM-36)
telling the model when to call it. Add unit + e2e tests. Document it here.
