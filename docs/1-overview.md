# 1. Overview

**apple-fm** gives command-line and programmatic access to Apple's **on-device
Foundation Models** (Apple Intelligence) on macOS 26+. Apple ships the
`FoundationModels` framework as Swift-only API with no command-line front-end;
apple-fm fills that gap with a tiny Swift helper plus a tested, typed Node layer,
distributed via npm (and, planned, Homebrew).

## Goal

Make the on-device model usable the way other model CLIs are — free, private, and
offline — for three shapes of use:

```bash
apple-fm probe                       # is the on-device model available?
apple-fm generate "Summarize: …"     # one-shot text (pipe stdin too)
echo "…" | apple-fm generate --schema shape.json   # structured/guided output
apple-fm chat                        # interactive chat, streamed, auto-compacted
```

And the same, programmatically:

```ts
import { probe, generate, ChatSession } from 'apple-fm';
if ((await probe()).available) {
  const text = await generate({ prompt: 'Summarize: …' });
  const chat = new ChatSession({ system: 'You are concise.' });
  await chat.send('Hello');
}
```

## Principles

- **No API key, no network.** Everything runs on-device; the model is whatever
  Apple Intelligence has installed. apple-fm never sends data off the machine.
- **Thin native surface, tested logic.** Only `apple-fm-helper/main.swift` touches
  `FoundationModels`. All policy — argument parsing, the wire protocol, chat
  history, auto-compaction — lives in strict TypeScript and is unit-tested
  against a stub helper, so the suite runs on any platform.
- **One binary, three shapes.** Probe, one-shot generation (freeform, chat, or
  guided), and interactive chat are modes of a single tool, not separate
  programs.
- **Future-proof by construction.** The binary resolves `SystemLanguageModel.default`
  at runtime, so model and OS updates are picked up without a rebuild. See
  [3-requirements.md](3-requirements.md) NFR-5.

## Why this exists

The same Swift shim had been re-implemented in three sibling projects (gitgist,
hotsheet, glassbox), each with its own wire shape and signing dance. apple-fm
unifies them: a single signed/notarized binary those projects (and anyone else)
can depend on.

## Related docs

- [2-architecture.md](2-architecture.md) — module layout and data flow.
- [3-requirements.md](3-requirements.md) — FR/NFR requirements with status.
- [4-protocol.md](4-protocol.md) — the helper ⇄ Node wire protocol.
- [ai/code-summary.md](ai/code-summary.md) — AI-oriented code map.
- [ai/requirements-summary.md](ai/requirements-summary.md) — AI-oriented
  requirements digest.
