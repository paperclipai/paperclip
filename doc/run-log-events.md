# Run-Log Events

Run-log events are rows in the `heartbeat_run_events` table
(`packages/db/src/schema/heartbeat_run_events.ts`). They stay in the instance
database. They are not Paperclip Telemetry events and not OpenTelemetry
exports, and they need no operator endpoint. See `rules/data-paths.mdc` for how
the three data paths differ.

This file does not list events or their payloads. Each event is defined where
it is written: search for the event name as a quoted string under `server/src`
and `packages` to find its producer and payload. Payload limits are defined in
`server/src/services/heartbeat/run-log.ts`; the storage codec lives in
`packages/db/src/run-event-payload.ts`. The server appends events through
`appendRunEvent` in `server/src/services/heartbeat.ts`.

## Payload storage

Structured events remain in `heartbeat_run_events`. When the instance's existing
file storage uses S3, new stdout/stderr NDJSON logs use the same stack bucket
and configured prefix under `run-logs/`, with existing run references in
Postgres. Local-disk instances remain local. Raw provider traces have their own
restricted, encrypted object path. See
[run evidence storage](run-evidence-storage.md) for batching, durability,
configuration, migration, retention, and qualification boundaries.
