# 12. Model discovery and selection

AFM-WHYAQM and AFM-3JHFK2 cover model discovery and selection for the CLI and library.

| Model ID | Listed by probe | Availability |
| --- | --- | --- |
| `on-device` | macOS 26 and later | Requires Apple Intelligence and a ready system model |
| `private-cloud-compute` | macOS 27 and later with a helper built against SDK 27 or later | Requires Apple’s managed entitlement and a ready Private Cloud Compute service |

The deployment target is macOS 26. The release helper builds against the macOS
27 SDK. Builds with the macOS 26 SDK expose the on-device model on all supported
versions. Apple documents Private Cloud Compute access for App Store
distribution and testing with TestFlight or ad hoc distribution. The npm
helper reports the cloud model as unavailable with `missingEntitlement`.
[Apple Private Cloud Compute access](https://developer.apple.com/private-cloud-compute/)

`apple-fm probe` emits JSON. Each entry in `models` contains an `id` and an
`available` boolean. Unavailable entries also include a `reason`. The top-level
`available`, optional `reason`, and CLI exit status continue to report on-device
availability for existing scripts. Legacy helper overrides may omit `models`.

Pass a listed, available ID through `--model` in `generate` or `chat`. The library
accepts the same IDs through `GenerateRequest.model`, `ChatSessionConfig.model`,
and `LiveSessionConfig.model`. The default is `on-device`. Chat uses its startup
selection for every turn, reset, and compaction. An explicit unavailable cloud
selection fails without generating a reply. Selecting Private Cloud Compute
sends inference requests to Apple’s service.

See the [wire protocol](4-protocol.md) and [manual test plan](manual-test-plan.md).

Apple-approved cloud inference and distribution validation is tracked in AFM-8KVSCA.
