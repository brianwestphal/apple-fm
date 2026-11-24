---
name: hotsheet-dispatcher
description: Keep a local dispatcher assigning independent Hot Sheet tickets while an integrator reviews and ships handoffs.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

<!-- hotsheet-skill-version: 10 -->

Own the whole queue plan and worker refill. The `$hotsheet-integrator` session alone owns
`main`, review decisions, gates, push, CI and ticket completion. `$hotsheet-worker`
sessions own exact claims and isolated worktrees. Follow the project's `AGENTS.md`.
The durable coordination state is the assignment authority; chat cues only prompt a
recipient to read it.

## Effective development strategy (HS2-F9062F)

At session start and before a new assignment after a project-policy change, run
`hotsheet-cli -C <shared-store> coordination --project <main>
development-strategies` for the shared policy version, then run
`hotsheet-cli -C <shared-store> coordination --project <main>
development-strategy-resolve` with applicable `--session <strategy-name>` and
`--ticket <strategy-name>` overrides. They name policies, not session generations.
Use the returned `source`, `integration`, `local_gate`, and `custom` fields to
plan risk, test-plan timing, required browser/platform/performance capacity,
T0/T1 budget, and staging throughput. `unconfigured-project` retains the
existing integration default and risk-selected checks. If this CLI lacks the
resolver, report the missing capability instead of guessing a policy.
Explicit user direction precedes ticket, session, and project policy unless it
would waive a mandatory gate or green-main boundary; report and refuse that
conflict. A ticket override precedes a session override only when validated by
the resolver. Supply an explicit user-selected strategy as the highest-priority
`--ticket` value and record user provenance separately. A policy change does
not rewrite an accepted assignment: re-resolve and apply it to future
assignments at a safe boundary.

## Start and preserve authority

Use one shared store, shipping checkout, dispatcher id, fresh session generation,
return route and availability lease for this invocation. First check the selected
`hotsheet-cli` executable with `command -v hotsheet-cli` and `hotsheet-cli coordination
capabilities`. Confirm dispatcher, reviewed scopes, and the exact `assign` flags in
`coordination --help` before touching a live pool. A source checkout can build a
current CLI in an isolated build checkout; other projects need their supported
headless upgrade path. Do not replace a user's global CLI or start a second pool.

Before a schema-one/two migration or schema-four/five upgrade, the integrator must
stop old waiters, switch every participant to the verified same artifact and
explicitly enable dispatcher authority. Even older `status` and `setup` may migrate
schema-one/two state on open (HS2-A1F615). A candidate linked worktree shares the
live Git common directory: test upgrades in a disposable independent project and
store. In legacy schema-three/integrator authority, the integrator alone assigns;
the dispatcher waits unregistered. Only the exact live integrator may run
`authority --mode dispatcher --all-participants-upgraded`. Never assume the skill
itself switches authority (HS2-TWZW7X).

Use `hotsheet-cli -C <shared-store> coordination --project <main>` as the command
prefix, with `--project` before the subcommand. Run `setup`, inspect `status`, then
wait with `next --role dispatcher --id <dispatcher> --session <generation>
--route <return-route> --lease-seconds <lease-seconds> --after <cursor>`.
`next` registers only after dispatcher authority is enabled and re-registers from
its own route and lease flags; repeat them on every wait and on
`register --role dispatcher --id <dispatcher> --session <generation>
--route <return-route> --lease-seconds <lease-seconds>` renewals (HS2-CP6GWA).
Keep the yielded wait running. Genuine state/cursor/lease events wake it; do not
poll the store or network on a timer. A stale or duplicate generation is refused.

## Read the integration strategy

`status` reports `integration_strategy`, the live integrator's strategy (null
without a live integrator), and `coordination strategies` prints the project policy
(HS2-NEY1QH). Under `serial`, `batch` (HS2-9G0M3V) and `ci-staged` (HS2-GT57BQ),
apply every rule below unchanged. Batch integrates several handoffs together, but only
those whose paths do not overlap, so precise declared scopes let more handoffs share a
batch. Under ci-staged, base every assignment on `main` as usual, never on the staging
branch. Never assign more freely because a project allows another strategy.

## Honor worker preferences and requests

Workers may state preferences on their availability (HS2-6WFCZR); they never select
or claim a ticket themselves, and you remain the only assignment authority. `status`
shows each worker's `preferences` (`prefer`, `only`, `avoid`, `request`, `refusal`)
on its session and, under `worker_matches`, its ordered `candidates`, an
`idle_reason` and a `request` check. Filters are `tag:`, `category:`, `priority:` and
`tier:`. Apply them as follows:

- `only` and `avoid` are strict. `assign` refuses a ticket outside them, so never
  try to override them. A strict worker with no matching ready ticket stays idle with
  its `idle_reason`; do not fall back to other work for it.
- `prefer` is soft: within the normal priority order, give a worker the ticket it
  prefers first, then any eligible ticket. `candidates` already lists that order. A
  preference never outranks a higher-priority ticket.
- A `request` is honored only when the ticket passes every check an `assign` makes,
  including overlap. Assigning the requested ticket to that worker consumes the
  request. Otherwise record the refusal with `refuse-request --id <dispatcher>
  --session <generation> --worker <worker> --worker-session <worker-generation>
  --slug <slug> --reason <blocked|claimed|overlap|unsupported_source|not_ready|assigned|filtered>
  --detail "<one line>"`. The `request.reasons` list names the reasons the snapshot can
  see; overlap is yours to judge from the scopes. The worker's wait wakes on a new
  refusal.
- When two workers request the same ticket, pick one by your normal rules and refuse
  the other with `assigned` once the first is reserved.
- `unmatched_tickets` lists ready tickets that no live idle worker's strict filters
  admit. Report them to the integrator as starving work; do not reassign a strict
  worker to clear them.

## Refill independent workers

Read the whole Up Next queue and each candidate ticket, its latest notes, exact
claim and qualified source. `ls --unblocked` filters visible `blocked_reason`; it
does not prove that `blocked_by` dependencies are closed (HS2-BSYW6F). Assignment
skips a ticket with a `blocked_reason`, although an exact claim may still take it so a
person or agent can re-evaluate the reason (HS2-BAK4BC). Check
dependencies, source capabilities, live worker generation, overlap and the
integrator's latest published safe base before every reservation. `status` exposes
`live_dispatcher`, `dispatch_blockers`, assignments and the integration report;
unknown or unsupported source state is not an empty queue. A published report from
a replaced integrator generation is stale until that integrator republishes.

The integrator publishes the full main SHA, qualified blockers and in-flight
scopes with `publish`. It alone reviews `--shared <file>` documents. Use
`path#row:<id>` or `path#heading:<slug>` only for distinct reviewed sections;
whole files, directories and unreviewed sections remain exclusive (HS2-YHYNJ6).
Do not omit a shared documentation file from a worker's declared scope. Source
worktrees do not isolate browser ports: workers running fixtures concurrently need
distinct owned endpoints (HS2-BJ00D1).

For each ready worker and independent ticket, reserve with
`assign --id <dispatcher> --session <generation> --worker <worker>
--worker-session <worker-generation> --operation <stable-id>
--connection <source> --native-id <native-id> --slug <slug>
--base <published-full-sha> --scope <path-or-reviewed-section>`.
Repeat `--scope` for all expected changed paths. The runtime serializes fresh
ticket, claim, dependency, availability and overlap checks under the selected
source transaction and coordination lock. A reservation is not the worker's
atomic ticket claim. Retry an uncertain delivery with the same operation id and
identical arguments; never mint another reservation to make a lost cue appear
successful. Only the live dispatcher may reserve in three-role mode. Verify the
worker's exact live claim before treating acceptance as work in progress.

## Workers on the project's other sites (HS2-5P112Z)

When this checkout is a project's home site, workers on the project's other sites
join this pool through the orchestrator. They register with the human-relay
return route. Where the pool takes requests, a worker's request names the exact
ticket of its run.

- Assign them like any worker, with the same scope and non-overlap checks.
- An assignment reaches them through the orchestrator as a `site_assigned`
  message.
- Never assign a ticket to a site's worker that is not the ticket it requested.

## Provisional dependents (HS2-2SJPCH)

Confirmed readiness is the default: `assign` refuses a ticket until every
`blocked_by` dependency is closed. A project may opt in with `speculation-policy
--enable`; read the policy with `speculation-policy` at session start and never
enable it yourself. Under an enabled policy `assign` also accepts a dependency
that is in `final_testing`, has a recorded `CI gate commit: <full SHA>` reachable
from the shipping branch, and whose CI gate is undecided. A red, superseded or
cancelled gate, an unpushed or unrecorded commit, a `speculate:never` tag on
either ticket, and a stack deeper than `max_depth` (default 1) all refuse.

- Before reserving, run `speculation-explain --ticket <slug>`. It answers
  `confirmed`, `provisional on <slug> CI <run>` with the base commit and pending
  gate, or each blocking reason code.
- Reserve with the ordinary `assign`; `--base` must be the integrator's published
  SHA and must contain every pending gate commit. The reservation records the
  speculative base SHA, the pending gates and the depth. `speculation-status`,
  `status`, `workers` and MCP `hotsheet_workers` show them.
- Opt a risky ticket out with the `speculate:never` tag (`hotsheet-cli edit <slug>
  --tag …` or MCP `hotsheet_update`). Tags replace the list, so keep the others.
- While any gate is pending, wait with `speculation-sync --wait-ms <ms>` next to
  your `next` wait. It reads the machine's CI watch Jobs and blocks on their file
  events; it never polls and never contacts the CI provider. If it answers
  `event_source: none`, no watch exists: do not call it again in a loop. A gate nobody
  watches stays `unknown`: ask the integrator to start `hotsheet-cli job watch
  ci`, or record the result with `speculation-result --gate-commit <sha> --result
  <green|red|superseded|cancelled> --run <id>`.
- Green confirms the work and changes nothing else.
- Red marks every dependent `at_risk`, writes one note per dependent and one on
  the failing ticket naming the run, and lists the failing ticket under
  `repair_first`. Assign that repair before any new work; the runtime refuses new
  provisional reservations until it is repaired. Do not release, recover or
  reassign at-risk work: it is rebased or reopened, never discarded.
- `reevaluate` lists superseded or cancelled gates. Have the gate watched again
  (`job watch ci --rewatch`) or, when another commit replaced it, have the
  integrator record `speculation-rebase`.

Use the optional `--return-route` and `--route-evidence-note` only when the selected
CLI advertises both (HS2-HM9FRV). First write a separate regular
`## Assignment return route` note authored by this dispatcher on the exact ticket,
whose JSON names the operation, worker, generation and verified recipient. Native
delivery requires the same agent tree; a terminal route requires that exact session
to advertise `message` in `GET /connections`. Otherwise use human relay. Keep the
integrator's global route unchanged. Record the assignment id, declared scopes and
return route in the ticket; a chat cue is not evidence of acceptance.

A worker's released code or findings handoff remains in the integration backlog,
while the same worker becomes available for another independent assignment. No chat
delivery is required for this durable refill. Inspect
the durable handoff and exact claim release, then refill promptly without waiting
for the integrator's review, local gate or CI. Keep the prior source branch and
worktree until the integrator verifies integration. Review returns use a NEW
assignment and preserve the original operation and artifact (HS2-65ETRJ). A scope
that proves too narrow is blocked and returned through the reviewed scope-change
path, not silently widened. The integrator retains the exclusive integrating or
verifying fence and the final review decision. The integrator may address up to
two separate advisory reviewers of a frozen handoff (HS2-E20S6K). They are not
registered implementation workers and never enter this dispatcher pool. The
worker's executable handoff preflight is available on current runtimes (HS2-NNSWDS).

Report `no_live_dispatcher`, `no_integrator_registered`, stale or missing base,
unavailable worker, blocked independent work, unsupported source and expired
session separately. `coordination finish --reason drained` is the integrator's
decision only after work, handoffs and CI are exhausted; do not infer that from
an empty local view. If a supported wait ends or the user stops this session,
run `leave --role dispatcher --id <dispatcher> --session <generation>` and
release any ticket claim you hold. An ended independent app session has no
automatic wake; name the human or supported terminal route needed to resume it.
