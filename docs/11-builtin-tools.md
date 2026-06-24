# 11. Built-in Tools

Requirements for the **built-in tools** apple-fm ships for the model to call
(FR-14 / AF-5). The generic tool-calling mechanism is in
[9-tool-calling.md](9-tool-calling.md) and the permission gate in
[10-permissions.md](10-permissions.md); this doc is the per-tool requirements view —
what each built-in does, its arguments, and its safety properties.

> **Status:** `read` (phase 1, AFM-31) and `bash` (phase 3, AFM-33) shipped and
> on-device verified. (A `web` fetch tool shipped under AFM-34 but was **removed in
> AFM-43** — the on-device model wasn't reliable enough with it; apple-fm makes no
> network calls.) Each tool is enabled with `chat --tools <name>` and gated by the
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
| URL guard | An `http(s)://` path returns a clear "this is a URL, not a local file; apple-fm cannot fetch URLs" message (not a raw `ENOENT` the small model misreads as "page not found") — AFM-41/43. |

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

> **Removed: `web` (fetch).** A networked `web` tool — GET an http(s) URL, return its
> readability-extracted text — shipped under AFM-34 (`src/tools/builtin/web.ts`, with a
> `docs/12-web-extraction.md` requirements doc) but was **removed in AFM-43**, both files
> deleted. The on-device model was too
> unreliable with it to justify being the one tool that leaves the machine, so apple-fm
> is back to **no network at all** (NFR-1). The generic tool round-trip is unaffected; a
> consumer can still register their own networked `Tool` via the library if they want.

## Testing

- **Unit**: `tests/tools.test.ts` (`read` + registry + the URL guard), `tests/bash.test.ts`
  (`bash`, real `/bin/sh`) — all device-free.
- **E2E** (`tests/e2e/cli.e2e.test.ts`): `read` / `bash` run through the assembled CLI
  behind the gate (pre-authorized runs; piped-non-interactive denies); a `read` of a URL
  returns the "not a local file" message (not `ENOENT`); an empty model reply prints
  `(no response)` rather than a blank line.
- **On-device** (AF-2): the real model called `read` (returned a file's secret) and
  `bash` (ran `echo SMOKE-$((6*7))` → `SMOKE-42`).

## Adding a built-in

Implement `Tool` in `src/tools/builtin/<name>.ts`, add it to `BUILTIN_TOOLS`
(`src/tools/index.ts`), export it from the public API (`src/index.ts`), give it a
`permissionKey`/`describe` if calls should be gated more finely than the whole tool,
and a one-line `usageHint` (folded into the CLI's auto tool-use system prompt, AFM-36)
telling the model when to call it. Add unit + e2e tests. Document it here.
