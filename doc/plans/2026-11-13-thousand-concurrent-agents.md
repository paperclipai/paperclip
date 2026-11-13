# Plan: 1,000 concurrent agents on one workspace

Date: 2026-11-13. Status: Phase 1 started. When this was written only the
load model in `scripts/benchmark-agent-scaling-load.ts` existed.

## Finish line

One hosted workspace runs 1,000 agents at the same time, served by several
server processes, and all of these hold for one hour:

| Measure | Target |
| --- | --- |
| Runs that need Retry | 0 |
| Main-thread CPU of every server process | below 60% of one core |
| Run event lateness (runner emits → row committed), p99 | below 1 s |
| Agent API request time before the handler, p99 | below 100 ms |
| Lease renewals that miss their deadline | 0 |
| Board page API requests, p90 | below 500 ms |
| Killing one server process | its runs resume on another, no Retry |

Intermediate gates: 50 agents on one process, then 200 on one process, then
1,000 on several.

## Why 50 struggles today

One Node process controls every run of a workspace. Its main thread is the
limit, not the database.

| Evidence | Result | Source |
| --- | --- | --- |
| Main thread of the staging server | 93–96% of one core, container limit 24 | OS thread sample, Nov 11 and 12 |
| Database CPU | 1–2 vCPU of about 8; most "active" sessions wait for the app | Neon, Nov 11 |
| Building SQL text in Node | 24% of main-thread CPU, 46% of 78 MB/s allocated | CPU profile and allocation sample, Nov 11–12 |
| Garbage collection | 13–25% of the main thread | same profiles |

The per-agent work that produces that load, read from the code:

| Source | When | Server work |
| --- | --- | --- |
| Run events | every event, also every text delta | one transaction of 4 round trips, a run-row lock, a count over the run's events, 2 hashes, 3 or more JSON serialisations (`heartbeat-run-events.ts:172`, `paperclip-control-plane-port.ts:360`) |
| Controller checkpoint | every event that is not a delta, every command | serialise the journal, encrypt, one transaction on a 3-connection pool (`durable-prp-control-plane.ts:403`, `native-runner-checkpoint.ts:128`) |
| Agent API and tool calls | every request | about 13 round trips before the handler, none cached (`middleware/auth.ts:326`, `run-identity.ts:546`) |
| Lease renewal | every 20 s per remote run | one transaction on a 2-connection pool; wakes 6 recovery queues (`native-execution-lease.ts:311`) |
| Run log to object storage | 1 s timer per run | 4 upload slots for the whole process (`object-run-log-store.ts:72`) |
| Agent-file checkpoint | end of every turn | agent row lock held across file walk and upload; 2-connection pool (`agent-file-store.ts:197`) |
| Workspace snapshot, harness backup | run end, session close | archive bytes pass through the server |

None of the event work depends on a viewer. Only the last hop to a browser
socket is gated on a subscription (`realtime/live-event-delivery.ts`).

## Load model result

`scripts/benchmark-agent-scaling-load.ts` drives the real append, checkpoint,
lease-renewal and agent-authentication code for N simulated agents in one
process against a local PostgreSQL. Assumed per-agent rates: 20 deltas/s,
1 other event/s, 0.3 API requests/s, one renewal per 20 s. 50 agents, 20 s
window, main pool of 10 connections unless stated, 2026-11-13.

| Scenario | Statements/s | Event-loop utilization | Deltas done of offered | Delta lateness p50 / p99 | API auth p50 / p99 |
| --- | --- | --- | --- | --- | --- |
| All sources | 2,589 | 0.60 | 10,744 of 20,000 | 4.5 s / 9.2 s | 464 ms / 1,084 ms |
| All sources, deltas at 2/s | 865 | 0.23 | 2,000 of 2,000 | 2 ms / 81 ms | 7 ms / 23 ms |
| Everything except deltas | 465 | 0.17 | — | — | 7 ms / 37 ms |
| Deltas only | 3,930 | 0.47 | 19,669 of 20,000 | 9 ms / 1.5 s | — |
| Deltas only, pool of 30 | 4,000 | 0.54 | 20,000 of 20,000 | 3 ms / 165 ms | — |

What it shows:

- Deltas are about 85% of the statements (3,930/s against 465/s for
  everything else).
- With all sources on, the process finishes about half the offered deltas and
  falls seconds behind. Agent authentication slows from 7 ms to 464 ms because
  it shares the pool with the delta transactions.
- Ten times fewer delta transactions removes the backlog and returns
  authentication to 7 ms. This is the case for change 1a.
- A larger pool removes the lateness for deltas alone, so in this model the
  first limit is the pool, each delta holding a connection for four round
  trips. On a hosted database each round trip is slower, so the same pool
  saturates sooner.
- Lease renewal is negligible at 50 agents (about 16 commits/s).

Limits: the machine was under other load (load average 13–20), so absolute
figures are noisy; an earlier pass under heavier load finished fewer deltas.
Raw output is not kept in the repository.

## Why more servers do not help today

| Assumption | Where | Effect with two steady processes |
| --- | --- | --- |
| Only the newest process starts runs | `run-start-handover.ts:10`, `deployment-notifications.ts:11` | the older one takes no new work |
| A run's socket, timers and session state live in one process | `runner-prp-outbound.ts:242`, `native-session-executor.ts:416` | Stop, steer and answers must reach the owner |
| Live events are an in-process emitter | `live-events.ts:7` | a browser on the other process sees nothing |
| The per-agent start lock is an in-process map | `agent-start-lock.ts:4` | two processes can exceed an agent's run limit |
| Cross-process wakes carry no scope | `packages/db/src/work-signals.ts:79` | each renewal makes every other process rescan every run |
| Every pool and upload limiter is per process | `packages/db/src/client.ts:306,375,454` | limits multiply, nothing is coordinated |

The fencing model for a second process exists (boot id, epoch, leases in
`controller-instance-lease.ts`), but it was built for deploy overlap.

## Phases

### Phase 0: measure (this week)

1. Land the load model and record its baseline (done locally, see above).
2. Add a per-run statement and transaction counter to the server's existing
   database response capture, exported as a metric, so hosted runs report
   "statements per agent per second" by source.
3. Build a scripted runner that replays a recorded event stream at a set rate
   with no model call, so 50 to 1,000 real runs cost only sandbox time.
4. Run 50 scripted agents on a hosted staging stack that is not
   `paperclip.staging`, with a CPU profile. This confirms or corrects the
   ranking on hosted round-trip times.

### Phase 1: cut the per-agent cost (target: 200 agents on one process)

Each item is one PR with a red/green test and a before/after from the load
model.

| # | Change | Expected effect |
| --- | --- | --- |
| 1a | Commit deltas in batches: one transaction per runner frame batch or per 250 ms per run, acknowledging the runner after the batch commits | delta transactions per agent from about 20/s to at most 4/s |
| 1b | Keep the retained count and highest sequence on the run row instead of counting event rows on every append | append cost stops growing with run length |
| 1c | Read the run's identity once per identity version and reuse it for the run's requests, keeping the per-request revocation read | pre-handler round trips from about 13 to 3 |
| 1d | Renew all of a process's leases in one statement per tick, as the legacy lease already does | renewals stop scaling with run count; no 2-connection queue |
| 1e | Serialise only the changed journal parts for a checkpoint; skip the agent-file transaction when the tree is unchanged | checkpoint CPU stops growing with journal length |
| 1f | Upload archives from the sandbox straight to object storage with a signed URL; the server records the digest | no archive bytes on the server |
| 1g | Size the shared limiters (log uploads, checkpoint pool, recovery pass) from the active run count | no fixed slot count below the run count |

### Phase 2: several controller processes (target: 1,000)

| # | Change |
| --- | --- |
| 2a | Any live process may claim a queued run. Replace "newest process starts everything" with a per-run claim; keep epoch fencing for deploys |
| 2b | Route Stop, steer, answers and approvals to the owning process through a durable per-run command row plus a wake |
| 2c | Publish live events across processes (PostgreSQL notify with the event id, body read from the row), so a browser can connect anywhere |
| 2d | Move the per-agent start lock and concurrency count into the database claim |
| 2e | Give cross-process wakes a scope, and let each process sweep only the runs it owns; a dead owner's runs are found by lease expiry |
| 2f | Separate the roles: API processes serve the board and agent requests, controller processes own runs; scale each on its own |

2a and 2e change run ownership, so they must pass the restart-chaos waves at
0% Retry before any hosted rollout.

### Phase 3: prove it

1. Ladder with the scripted runner: 50, 200, 500, 1,000 agents, one hour
   each, on a hosted stack that is not `paperclip.staging`.
2. Kill a controller process at each step and check the finish-line table.
3. `paperclip.staging` only after the owner's explicit go-ahead.
4. Repeat the 1,000 step with real model calls for a short window.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | May deltas be stored as one row per batch instead of one row per delta? Replay and the transcript stay complete; a crash can lose at most the unacknowledged batch, which the runner resends | yes; approved by the owner 2026-11-13 |
| 2 | Bus for cross-process events: PostgreSQL notify or a new Redis dependency | PostgreSQL first; revisit above 1,000 |
| 3 | Order of work: Phase 1 before Phase 2 | yes; several processes at today's cost would need about one process per 25 agents |

## Not verified

- The load model runs on loopback PostgreSQL on a developer machine. It
  measures the modelled sources only and has no hosted round-trip time.
- The per-agent rates (20 deltas/s, 1 other event/s, 0.3 API requests/s) are
  assumptions, not a recorded workload. Phase 0 step 2 replaces them.
- Staging's pool size and run-log storage mode were not read.
- Tool-gateway calls, recovery sweeps, and browser fan-out are not in the
  model.
