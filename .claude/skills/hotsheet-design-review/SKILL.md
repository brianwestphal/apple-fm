---
name: hotsheet-design-review
description: Run a Hot Sheet design-review loop for Kerf UI concepts with labeled attachment batches, annotation mapping, sign-off, and linked follow-ups.
---

# Hot Sheet design review

Use this skill when a Hot Sheet ticket asks for design concepts, mock revisions, or design sign-off in a project that uses Kerf UI. It covers only the ticket evidence and feedback loop. The installed Kerf `kerf-ui-design-mock` skill owns how to compose and capture concepts. Do not restate its component rules.

## Prerequisites

- Read the installed `node_modules/@kerfjs/ui/ai/design-mock/SKILL.md` from the package that the UI uses, and follow it for every baseline and concept capture. If the file is absent, stop and report the missing prerequisite: `@kerfjs/ui` 5.0.0-beta.129 or newer, then `npx kerfjs setup --ui --write --yes`. If the project does not use Kerf UI, this skill does not apply.
- Check the ticket source's capabilities with `hotsheet-cli providers --json` (MCP `hotsheet_providers`):
  - `attachments` must be true to attach batches. Otherwise stop and report that the design loop needs an attachment-capable source. Copy the ticket to one (`provider-copy`) only when the user asks.
  - `attachment_edit` covers annotations. When it is false, take feedback from notes only, and say so in each revision note.

## Every action

Re-read the complete ticket first with `hotsheet-cli show <slug>` or MCP `hotsheet_get`. That includes every note, attachment and annotation, plus any reference art, prior implementation or other project that the ticket names. Quote the note or annotation you act on. Claim the ticket, keep its phase current, and release the claim under the normal Hot Sheet workflow.

## Baseline and concept batches

1. Capture the real current screen as the baseline, with synthetic data. Then capture the proposed concepts as the Kerf skill directs.
2. Attach each revision as one labeled batch, identified as AI work and marked as reference material:
   `hotsheet-cli attach <slug> --batch-label "Design v1" --purpose reference --actor-role ai --actor-id <id> <files...>`
   Attach files with the CLI; the MCP server can correct batch, purpose and actor metadata afterwards (`hotsheet_set_attachment_metadata`) but does not upload files. Use the Kerf skill's file names, which encode concept, state, viewport, theme and revision, for example `groups-list-collapsed-390-dark-v1.png`. Put the baseline in its own `Design baseline` batch.
3. Add a regular note headed `## Design v1` that covers:
   - which file covers which state, viewport and theme;
   - what is proposed and what is unchanged from the baseline;
   - open decisions, as a `CHOICE:` list when they narrow to options;
   - Kerf capability gaps;
   - the limits of the mock.

   A mock is design evidence, not verification of shipped behavior.

## Review pass

1. Read the current annotations by stable attachment id. They appear under each attachment in `hotsheet-cli show <slug>` or `hotsheet_get`. Identify an attachment by its id, never by upload order. Read the notes too.
2. Classify each piece of feedback:
   - An approval note approves a named revision.
   - An annotation with text and an intent of `change`, `bug`, `insert`, `remove` or `move` is a requested change.
   - An annotation with a `question` intent is an unresolved choice.
   - An annotation without text, or a bare `comment` region with nothing to act on, marks a location, not feedback. Ask what it means instead of guessing.
3. Never replace, rename, re-annotate or delete an annotated original. Attach the next revision as a new batch (`Design v2`). Add a `## Design v2` change log that quotes each annotation (attachment id and annotation id) or note, and maps it to the decision or revised capture that answers it. Carry unresolved choices forward.

## Sign-off and follow-ups

1. Create implementation follow-ups only after explicit design sign-off. Sign-off is a maintainer note or an answered feedback request that approves a named revision. Record it in a `## Design sign-off` note naming the approved batch label and attachment ids.
2. Keep product implementation separate from upstream Kerf gaps.
   - Product work goes in app tickets: `hotsheet-cli new --title ... --follow-up-to <slug> --project <checkout>`. The `--project` checkout keeps the follow-up link qualified.
   - A missing Kerf prop, variant or component goes in a `KF-*` ticket in the Kerf store.
   - Each follow-up names the approved revision and the relevant attachment and annotation ids.
   - Preserve every unresolved choice, either as a decision on the design ticket or as a separate ticket.
3. List every follow-up slug in the design ticket's completion note.
