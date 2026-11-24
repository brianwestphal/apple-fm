# 12. Model discovery and selection

apple-fm uses Apple's general-purpose `SystemLanguageModel.default` on macOS 26
and later. macOS supplies the model version. Its ID in apple-fm is `on-device`.

`apple-fm probe` emits JSON with a `models` array containing the `on-device` entry.
Each entry includes an `id`, an `available` boolean, and a `reason` if unavailable.
The top-level `available`, optional `reason`, and CLI exit status also report
on-device availability for existing scripts. Legacy helper overrides may omit
`models`.

Use `--model on-device` with `generate` or `chat` to select the model explicitly.
The library accepts the same ID through `GenerateRequest.model`,
`ChatSessionConfig.model`, and `LiveSessionConfig.model`. It is also the default
for generation, chat, and compaction.

## Token counting

On macOS 26.4 and later, `apple-fm tokens [text]` prints one integer and reads
stdin when the argument is omitted. The library exposes `countTokens(text)`.
`probe` includes the optional native `contextSize` in tokens. Chat measures the
active native transcript plus the pending user message when the helper supports
it. It compacts at the configured threshold or 75% of native capacity, whichever
is lower. Older helpers, older releases, and failed counts use the existing
length-based estimate (AFM-RT2FK2).

## Image input

Use `generate --image <file> "Describe this image"` on macOS 27 and later
(AFM-K4DHM0). A prompt can also come from stdin. Image input works with the
general use case, streaming, and guided JSON output. The library accepts a
local path in `GenerateRequest.imagePath`. The helper must be built with the
macOS 27 SDK. Its deployment target remains macOS 26.

## Sampling

Pass `generate --sampling greedy` to choose the most likely token at each
step (AFM-C7EA41). The library accepts `GenerateOptions.sampling: 'greedy'`.
Omit the option to use the system default. Greedy sampling also works with
guided generation. A manually overridden helper should be rebuilt to pick up
the new option.

## Content tagging

With `generate --use-case content-tagging`, apple-fm uses the on-device
`SystemLanguageModel(useCase: .contentTagging)` specialization on macOS 26 and
later (AFM-AADSBY). Pass standalone text as the prompt argument or via stdin.
The command writes a JSON array of short strings. It extracts topic tags by
default. Use `--system` to ask for actions, objects, or emotions. Tag wording
and language may vary.

```sh
printf '%s\n' "We had a picnic at the beach." | apple-fm generate --use-case content-tagging
```

The tagging use case has a fixed array output and cannot be combined with
`--stream` or `--schema`. `generate --use-case general` uses regular generation,
which is the default. Chat uses the general use case. In the library, set
`GenerateRequest.useCase` to `content-tagging` and parse the returned JSON string
to read the tags.

See the [wire protocol](4-protocol.md) and [manual test plan](manual-test-plan.md).
