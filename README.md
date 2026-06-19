# apple-fm

Command-line and programmatic access to Apple's **on-device Foundation Models**
(Apple Intelligence) on **macOS 26+ / Apple Silicon**. Free, private, offline —
nothing leaves your machine.

Apple ships `FoundationModels` as Swift-only API with no command-line front-end.
apple-fm provides one: a tiny Swift helper does the model work, and a tested,
zero-dependency Node layer gives you a CLI and a library.

> ⚠️ **Early scaffold.** The Node layer is fully unit-tested; the Swift helper is
> smoke-verified on a macOS 26 / Apple Intelligence machine (probe, generate,
> stream, schema, chat all work). Native guaranteed-structure output, an
> automated on-device CI test, and signed release binaries are still to come —
> see [docs/3-requirements.md](docs/3-requirements.md).

## Install

```bash
npm install -g apple-fm     # CLI
npm install apple-fm        # library
```

Requires macOS 26+ on Apple Silicon with Apple Intelligence enabled. The package
bundles a prebuilt helper; you can also build it from source:

```bash
npm run build:helper        # → bin/apple-fm-helper (needs Xcode 26 / macOS 26 SDK)
```

The helper is located via `APPLE_FM_BIN`, then the bundled `bin/apple-fm-helper`,
then `apple-fm-helper` on `PATH`.

## CLI

```bash
apple-fm probe                       # is the on-device model available?
apple-fm generate "Summarize: …"     # one-shot text
cat notes.md | apple-fm generate     # read the prompt from stdin
apple-fm generate "…" --stream       # stream tokens as they arrive
apple-fm generate "…" --schema shape.json   # structured/guided JSON output
apple-fm chat                        # interactive chat (streamed, auto-compacted)
```

Run `apple-fm --help` for the full flag list.

## Library

```ts
import { probe, generate, ChatSession } from 'apple-fm';

if ((await probe()).available) {
  // One-shot
  const summary = await generate({ prompt: 'Summarize: …', system: 'Be terse.' });

  // Streaming
  await generate({ prompt: '…', stream: true }, {}, (chunk) => process.stdout.write(chunk));

  // Multi-turn chat with automatic context compaction
  const chat = new ChatSession({ system: 'You are a helpful assistant.' });
  const reply = await chat.send('Hello');
}
```

## How it works

A single binary, three shapes (probe / generate / chat), all over one
line-delimited JSON protocol ([docs/4-protocol.md](docs/4-protocol.md)). The chat
session keeps the transcript on the Node side and, when it approaches the
on-device model's small context window, summarizes older turns and continues —
so long conversations stay coherent. Because the helper resolves the current
on-device model at runtime, OS and model updates are picked up without a rebuild.

## Documentation

- [Overview](docs/1-overview.md) · [Architecture](docs/2-architecture.md) ·
  [Requirements](docs/3-requirements.md) · [Protocol](docs/4-protocol.md)

## License

MIT © Brian Westphal
