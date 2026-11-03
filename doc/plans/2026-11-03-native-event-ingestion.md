# Native event ingestion: implementation and acceptance

Goal: reduce durable native ingestion work and improve visible streaming under
load, with no intentional collection delay. Deliver a cursor PR followed by a
dependent batching PR, each with correctness and measured incremental evidence.

## Fixed workload and measurement contract

- B0 is `2e37c73c05fe84aead1883b72fdf6b1653b58c2a`; B1 contains only the cursor
  change; B2 adds batching. Record exact tested commits and dirty-file hashes.
- Use the actual append service with disposable PostgreSQL and 1k, 10k and 100k
  histories. Include singleton writes, duplicate replay, sparse sequences and
  late gap closure. Setup and warmup are outside measured intervals.
- Qualify the harness with a small case. Measure baseline against itself before
  candidate comparison; retain the observed repeatability envelope. Compare at
  least five alternating pairs. Report median, spread, samples and all failures.
- Burst fixtures emit 16, 128 and 512 events, with 1, 10 and 100 concurrent runs.
  Include final drainage and independently compare stored identities/payloads.
- Application proof requires a production build, a separate arrival/load clock,
  and browser render observations. Measure SQL/transactions, lock waits, CPU,
  backlog/memory, event-loop delay and emission-to-render latency. A service
  benchmark alone cannot establish browser or deployed improvement.

## Acceptance gates

| Outcome | Gate |
| --- | --- |
| Flat steady-state cursor work | Indexed cursor/range operations do not scan retained history; long-history append cost improves beyond baseline noise. |
| Useful batching | Burst completion rate improves beyond noise in at least four of five pairs; fewer transactions per event; no missing work or hidden backlog. |
| Immediate streaming | First and isolated text start persistence immediately; no timer or minimum batch size; sparse render latency does not regress beyond baseline noise. |
| Loaded user experience | Combined change improves browser delivery latency beyond baseline noise under the same offered load. |
| Correctness and controls | Replay identities, gaps, conflicts, company scope, outer rollback and commit-before-effect barriers remain correct. Stop and control latency do not regress. |
| Compatibility and quiet | Stale projections use the correct fallback; bounded rebuild survives restart/old writers and stops all recurring SQL after draining. |

Do not lower these gates after measuring a candidate. An inconclusive or failing
comparison needs diagnosis, not a successful-performance claim.

## Implementation ownership and boundaries

- Cursor/range state belongs with heartbeat event persistence. It remains a
  derived optimization, fenced by the run's committed global-sequence marker.
  Existing histories use the correct aggregate fallback while a concrete rebuild
  obligation runs in 512-row transactions through the existing work coordinator.
- The native session runtime owns bounded read-ahead through its existing
  transformed iterator: 64 events / 64 KiB, one pending read and one append.
  Start the first append immediately; submit ready text as soon as the prior
  write settles. Nontext/P0 events remain ordering barriers.
- The control-plane port owns validation, ordered identity redaction and outer
  revocation fencing. Database batches commit before receipts, publication and
  callbacks. No numbered events are merged.
- Raw transport ACK/recovery policy is outside this change. Database receipts
  remain durable; raw ordinary-output ACKs do not universally promise transcript
  durability. The upstream normalized producer queue remains a separate limit.

## Verification record

Baseline SQL-only investigation: PostgreSQL 18.1, Node 26.4.0, five warm samples
per size. The current count/max query examined 1k / 10k / 100k index entries, with
median execution times 0.063 / 0.504 / 5.243 ms. This is mechanism evidence only.

Current state: implementation in progress. No candidate speedup or browser result
has been established. Dependencies are installed and the additive migration was
generated with the repository command. The lead owns integration and measurement
windows; workers own cursor services, benchmark harness and isolated runtime work.

Before delivery: run focused PostgreSQL/runtime tests, migration checks, required
typecheck/test/build gates, then the real browser native-run/tool/result/reload
and Stop journeys. Record target, exact revision, provider versus fixture, run
IDs, persisted outcomes and accessible evidence. Each PR uses the repository
template and includes its own measurements and remaining limitations. Deployed
claims require the exact serving revision and a separate matched verification.
