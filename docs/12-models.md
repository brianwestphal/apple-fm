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

See the [wire protocol](4-protocol.md) and [manual test plan](manual-test-plan.md).
