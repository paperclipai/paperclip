# Real cloud Stop acceptance (2026-11-03)

The normal task UI's Stop control cancelled a native run in a real Daytona sandbox. The production-built controller served `137501f595fd5ee13d395e26b4147ca8bc4d4eb6`; the provider was an explicitly declared deterministic Codex fixture executing a real `sleep 60`. This adds cloud termination coverage to the separate [live-LLM journey](2026-11-03-native-event-ingestion-live.md).

The [recorded proof](native-event-ingestion-2026-11-03/cloud-stop/qualification.json) contains the original native acknowledgement, shared cancellation acknowledgement with `provider_termination_receipt`, matching stopped-provider receipt, and the exact lease's successful release. Independent SDK observations confirmed child retirement, absence of its forbidden effect, and the same labelled sandbox's stopped state. Reload and direct PostgreSQL checks verified the retained transcript, canonical event hashes, cursor projection, and absence of a successor or accepted result.

This is one functional sample. Its acknowledgement timings establish no latency distribution, throughput improvement, or deployed-production gain. The database checks retain the existing sparse-source/cancellation policy; they do not equate every ordinary streaming wire ACK with database durability.

All five created sandboxes were independently confirmed absent. The [attempt ledger](native-event-ingestion-2026-11-03/cloud-stop/attempts.json) preserves four earlier harness failures and their cleanup. The controller, database and credential-bearing temporary data were removed; retained and decompressed artifacts were scanned for the actual credentials. The [reproduction recipe](native-event-ingestion-2026-11-03/cloud-stop/README.md) declares live versus simulated dependencies, resource bounds, immutable image, SDK, runtime hashes, and the public helper's credential, resource-cap and clock-guard adaptations. The [manifest](native-event-ingestion-2026-11-03/cloud-stop/manifest.json) records exact artifact hashes.

![Actual streaming and real command before Stop](native-event-ingestion-2026-11-03/cloud-stop/before-stop.png)

![Stopped run and persisted text after reload](native-event-ingestion-2026-11-03/cloud-stop/after-stop-reload.png)
