# Heartbeat Run Memory Operations

The heartbeat run list endpoint returns at most 200 rows by default and at most
1,000 rows when a caller supplies a larger limit. List queries extract the
small result summary in PostgreSQL. They do not materialize the full
`result_json` value in Node.js. The single-run detail endpoint keeps its
separate bounded detail contract.

The server writes a `process_start` event when memory monitoring starts. It
writes a `process_memory` event every 30 seconds. These records contain only
process counters:

- RSS
- V8 heap used, total, and limit
- external and array-buffer memory
- GC count, GC duration, and GC pressure for the sample window
- process uptime

The records do not contain request bodies, run results, logs, prompts, or other
private payloads. A new `process_start` event for the same instance identifies a
restart. A missing memory sample after a pressure warning can identify an abrupt
exit or OOM when it is correlated with the service manager exit reason.

The server warns when heap use reaches 75% of the V8 heap limit or GC consumes
20% of a sample window. Alert if either condition lasts for 10 minutes. Alert
immediately when a new process start follows a memory-pressure warning or when
the service manager reports an OOM exit.

## Heap ceiling rollout

Keep the current 12 GB old-space ceiling until the exact release head passes
representative concurrent list and log polling. The sample must use synthetic
payloads with production-shaped row counts and result sizes. It must not copy
production content.

Run the opt-in representative list check with:

```sh
PAPERCLIP_HEARTBEAT_MEMORY_LOAD_TEST=true pnpm exec vitest run \
  server/src/__tests__/heartbeat-list-load.test.ts --reporter=verbose
```

The check creates 24,205 synthetic runs containing more than 1.29 billion
logical `result_json` characters, issues eight concurrent default list reads,
requires every response to stop at 200 summary-only rows, and fails if the Node
process grows by 384 MB or more. The temporary database is deleted afterward.

The 2026-09-22 verification used 24,205 rows and 1,291,640,309 logical JSON
characters. Eight concurrent reads returned 200 summary-only rows each. Node
RSS moved from 532,971,520 bytes to a 533,692,416-byte peak, a 720,896-byte
increase. The pre-fix production observation for the same row count was roughly
1.29 billion materialized JSON characters per request and overlapping requests
produced 10–12 GB V8 heaps.

Set the initial steady-state old-space ceiling to 4 GB only when all of these
conditions hold for the exact release head:

- p95 heap use is below 1 GB under representative traffic.
- GC pressure does not remain above 20%.
- No OOM or unexpected restart occurs.
- List responses keep the documented summary contract.

Return the ceiling to 12 GB if heap use remains above 75% for 10 minutes or any
OOM or unexpected restart occurs. Preserve the memory samples and service
manager exit reason for the follow-up investigation.
