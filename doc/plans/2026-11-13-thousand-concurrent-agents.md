# Plan: 1,000 concurrent agents on one workspace

Date: 2026-11-13. Status: Phase 1 changes 1a to 1e and 1h are merged; 1f, 1g
and Phase 2 are not started.

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
1 other event/s, 0.3 API requests/s, one renewal per 20 s. 20 s window, main
pool of 10 connections unless stated. Measured 2026-11-13 on master before any
Phase 1 fix, machine load average 11–17.

| Agents | Scenario | Statements/s | Event-loop utilization | Deltas done of offered | Delta lateness p50 / p99 | API auth p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | All sources | 4,730 | 0.37–0.50 | 20,000 of 20,000 | 0.8 ms / 4–63 ms | 4–5 ms / 8–196 ms |
| 50 | All sources, deltas at 2/s | 1,130 | 0.16 | 2,000 of 2,000 | 1.2 ms / 5 ms | 5 ms / 24 ms |
| 50 | Everything except deltas | 731 | 0.13 | — | — | 5 ms / 13 ms |
| 50 | Deltas only | 4,000 | 0.39 | 20,000 of 20,000 | 0.9 ms / 22 ms | — |
| 100 | All sources | 9,460 | 0.72 | 40,000 of 40,000 | 1.2 ms / 24 ms | 6 ms / 93 ms |
| 150 | All sources | 12,300 | 0.83 | 50,788 of 60,000 | 1.1 s / 3.1 s | 268 ms / 422 ms |
| 200 | All sources | 12,180 | 0.92 | 50,976 of 80,000 | 3.5 s / 6.4 s | 352 ms / 2.3 s |
| 200 | All sources, pool of 30 | 12,670 | 0.91 | 49,173 of 80,000 | 4.2 s / 7.6 s | 350 ms / 597 ms |
| 200 | All sources, deltas at 2/s | 4,520 | 0.51 | 8,000 of 8,000 | 1.0 ms / 29 ms | 5 ms / 42 ms |

What it shows:

- Deltas are about 85% of the statements (4,000/s of 4,730/s at 50 agents).
- The process keeps up at 50 and 100 agents and saturates between 100 and 150,
  at about 12,300 statements/s. Past that point deltas fall seconds behind and
  agent authentication slows from 5 ms to hundreds of milliseconds.
- The limit is the Node main thread, not the pool: event-loop utilization is
  0.83–0.92 at saturation and a pool of 30 changes nothing.
- These sources alone use 37–50% of the event loop at 50 agents, with no
  network latency. A hosted server also runs tool calls, board requests and
  recovery sweeps on the same thread, which is consistent with staging
  saturating near 50.
- Ten times fewer delta transactions serve 200 agents at an event-loop
  utilization of 0.51. This is the case for change 1a.
- Lease renewal is negligible at these sizes (15 statements/s at 50 agents).

Limits: the machine carried other work, so timings vary between runs (the
ranges in the 50-agent row are two runs); statement counts do not. A first
pass under a load average of 40–60 finished only half the deltas at 50 agents;
that was the machine, not the server code, and it is not shown. Raw output is
not kept in the repository.

## Load model after Phase 1

Same model and rates, measured 2026-11-13 with the eight Phase 1 fixes below
(1a to 1e and 1h). The model now commits deltas as the server's port does (the
first text after another event at once, later deltas in one transaction per
250 ms or 100 deltas) and renews leases through the shared schedule. Machine
load average 11–15.

| Agents | Statements/s | Event-loop utilization | Deltas done of offered | Delta lateness p50 / p99 | Other events done of offered | API auth p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 50 | 1,780 | 0.26 | 20,000 of 20,000 | 103 ms / 253 ms | 1,000 of 1,000 | 2 ms / 10 ms |
| 100 | 3,570 | 0.46 | 40,000 of 40,000 | 105 ms / 258 ms | 2,000 of 2,000 | 2 ms / 69 ms |
| 200 | 7,110 | 0.73 | 80,000 of 80,000 | 151 ms / 573 ms | 4,000 of 4,000 | 3 ms / 452 ms |
| 400 | 11,380 | 0.99 | not reliable for this run (1) | 1.7 s / 2.2 s | 5,473 of 8,000 | 394 ms / 620 ms |
| 200, deltas and leases as before Phase 1 | 10,220 | 0.90 | 39,425 of 80,000 | 5.1 s / 10.2 s | 4,000 of 4,000 | 165 ms / 1.8 s |

(1) The model that measured this table still counted a delta that committed
after the window, while queued checkpoints drained. At 400 agents deltas ran
1.7 s late, so its count includes deltas outside the window. The model now
counts only deltas that commit inside the window; this row was not measured
again. At 50 to 200 agents every delta committed within its batch time, so
those counts are unaffected.

What it shows:

- Statements per agent per second fall from about 95 to about 36.
- One process now serves 200 agents with every delta committed within its
  batch time, where before it finished half of them and ran seconds behind. It
  saturates between 200 and 400 agents, against 100 to 150 before.
- A batched delta is committed up to 250 ms after it arrives. That is the
  design, not a backlog; the first text after another event does not wait.
- The ceiling is still about 12,000 statements/s on one thread. Delta batches
  are still the largest share: 4 transactions of 5 statements per agent per
  second. A longer batch time, or one transaction for the deltas of many runs,
  is the next step on one process; Phase 2 is the step past it.
- Lease renewal is under 1 statement/s at 400 agents (15/s at 50 before).
- The model does not measure server memory, so it does not show change 1h.

## Load model at recorded rates

The rates above were assumptions. Recorded hosted native runs show a much
lighter and different load, so the model's default changed on 2026-11-14.

Source: 40 recent native runs on one hosted workspace (median 26 minutes).
Events stored per run: 0.69/s at the median, 1.5/s at p90. Text deltas: 0.18/s
on average, 1.6–2.7/s in a run's busiest minute; a run streams text for about
8% of its life. Rows by event type: `run.performance.span` 10,030,
`item.delta` 9,502, `tool.execution.progressed` 6,951, `item.completed` 4,705,
`tool.execution.started` and `tool.execution.completed` about 2,150 each.
Controller checkpoint rows: about 1.4 per running run per second.

| Profile (`PROFILE`) | Deltas/s per agent | Other events/s per agent | Use |
| --- | --- | --- | --- |
| `recorded` (default) | 0.2 | 0.5 | median of the recorded runs |
| `burst` | 2.5 | 3 | a run's busiest minute |
| `stress` | 20 | 1 | the earlier assumption, kept for comparison |

API requests stay at 0.3/s per agent in every profile. Other events follow the
recorded mix (`EVENT_MIX`), and each type takes the server path it takes in
production:

| Event type | Share | Server path |
| --- | --- | --- |
| `run.performance.span` | 39% | written by the server's own run trace: one ordinary append, no wake, no checkpoint |
| `tool.execution.progressed` | 27% | runner event with a chat-progress wake: a transaction, then a controller checkpoint save |
| `item.completed` | 18% | the same (a final reply also wakes response presentation) |
| `tool.execution.started`, `tool.execution.completed` | 8% each | the same |

The model's delta batching now also follows #21520: deltas that arrive while a
batch commits go into one next batch, until the run's next runner event.

Measured 2026-11-14 on master (after #21511, #21520 and #21528), 60 s window,
main pool of 10 connections, embedded PostgreSQL on the same machine. Each run
started only when the machine's 1-minute load average was below 15; the load
average at the start and the end is shown. The machine is shared, and the
500-agent recorded run had other work start during its window (marked busy).

| Agents | Profile | Load avg start / end | Event-loop utilization | Statements/s | Per agent per second | Checkpoint pool statements/s | Other events done / offered | Other event lateness p50 / p99 | Delta lateness p50 / p99 | API p50 / p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 500 | recorded, busy | 14.9 / 22.2 | 0.66 | 1,979 | 4.0 | 688 | 14,774 / 15,000 | 3 ms / 5.2 s | 2 ms / 5.7 s | 3 ms / 7.1 s |
| 1,000 | recorded | 14.0 / 13.5 | 0.61 | 4,351 | 4.4 | 1,525 | 30,000 / 30,000 | 1 ms / 10 ms | 1 ms / 252 ms | 2 ms / 9 ms |
| 2,000 | recorded | 13.4 / 15.9 | 0.85 | 8,701 | 4.4 | 3,049 | 60,000 / 60,000 | 2 ms / 2.1 s | 1 ms / 2.2 s | 3 ms / 3.0 s |
| 250 | burst | 12.3 / 16.6 | 0.70 | 6,102 | 24.4 | 2,287 | 45,000 / 45,000 | 1 ms / 122 ms | 2 ms / 281 ms | 2 ms / 199 ms |
| 500 | burst | 13.8 / 11.7 | 0.95 | 12,114 | 24.2 | 4,488 | 90,000 / 90,000 | 4 ms / 171 ms | 9 ms / 318 ms | 5 ms / 268 ms |

No run had a failed operation, a failed checkpoint save or a lost lease.

What it shows:

- At recorded rates one process costs about 4.4 statements per agent per
  second, and about 35% of them are on the 3-connection checkpoint pool. The
  non-delta runner events and their checkpoint saves are most of the cost; text
  deltas are now a small share.
- On loopback PostgreSQL one process carries 2,000 agents at recorded rates
  (event-loop utilization 0.85, p99 lateness about 2 s), and 500 agents all in
  their busiest minute at the same time (0.95, p99 under 0.4 s).
- The 3-connection checkpoint pool kept up locally: about 4,500 statements/s,
  or 1,100 saves/s, at 500 agents in a busy minute. Since #21528 a save is 4
  statements (BEGIN, the owner lock with the transaction id, the write,
  COMMIT), and 5 where commit-time notifications are on (a `pg_notify` before
  COMMIT). Each save holds a connection for those round trips, so with a hosted
  round trip of about 1 ms the same 3 connections allow about 600–750 saves/s,
  which is about 330–400 agents in a busy minute. That is a per-process limit
  on a hosted database (change 1g sizes this pool); it is computed here, not
  measured.
- Earlier runs on 2026-11-14 at load averages of 20–55 showed one process
  falling behind at 500 agents in a busy minute and at 2,000 at recorded rates.
  With the machine quieter and the model's event order corrected, both kept up,
  so those earlier results described the machine, not the server code.
- The model saves a checkpoint without blocking the agent's next event. The
  controller acknowledges a runner event only after its checkpoint save, so in
  production a slow checkpoint pool also delays the run's next events. The
  model therefore understates the effect of that pool.
- On the hosted instance a CPU profile of the main thread (2026-11-14, with
  these fixes) shows building SQL text in Drizzle costing about as much
  main-thread time as postgres.js result parsing (each about a fifth). A
  statement with fixed SQL text, as in #21511, therefore saves more CPU there
  than its statement count suggests; the next changes should be judged by CPU
  per operation, not only by statements.

## Considered and not done

- **Stop writing `run.performance.span` rows.** These spans are the largest
  event type by rows, but each is one statement with no wake and no
  checkpoint. Recorded runs have about 190–250 span rows per run over a median
  of 26 minutes, about 0.12–0.16 rows per run per second: about 3% of the
  statements per agent. The top names are `tool.request.input_stream` (median
  56 per run), `tool.execute` (25), `execution.plugin_dispatch` (11) and
  `authorization.base` (7). Run forensics, the restart-chaos speed scripts and
  exports read these rows, so they stay.
- **Save a controller checkpoint only for critical runner events.** After the
  routine checkpoint save becomes one statement, this would save about 0.3
  statements per agent per second at recorded rates. It would change the
  acknowledgement order and the restore cursor of the runner's control plane,
  which is recovery-critical. Not now; revisit with the writer-thread work.

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
model. Item 1h is about memory, which the load model does not measure; its
before/after is retained heap per session. The catalog decides which tool
schemas a session may call, so the cache key must cover everything that
decides the admitted schemas, and nothing may be shared across companies.
Warm sessions have no cap in number and stay five minutes after the last
turn, so memory per session counts for idle agents too.

| # | Change | Expected effect |
| --- | --- | --- |
| 1a | Commit deltas in batches: one transaction per runner frame batch or per 250 ms per run, acknowledging the runner after the batch commits | delta transactions per agent from about 20/s to at most 4/s |
| 1b | Keep the retained count and highest sequence on the run row instead of counting event rows on every append | append cost stops growing with run length |
| 1c | Read the run's identity once per identity version and reuse it for the run's requests, keeping the per-request revocation read | pre-handler round trips from about 13 to 3 |
| 1d | Renew all of a process's leases in one statement per tick, as the legacy lease already does | renewals stop scaling with run count; no 2-connection queue |
| 1e | Serialise only the changed journal parts for a checkpoint; skip the agent-file transaction when the tree is unchanged | checkpoint CPU stops growing with journal length |
| 1f | Upload archives from the sandbox straight to object storage with a signed URL; the server records the digest | no archive bytes on the server |
| 1g | Size the shared limiters (log uploads, checkpoint pool, recovery pass) from the active run count | no fixed slot count below the run count |
| 1h | Keep one frozen, parsed tool catalog per catalog hash and company, shared by the sessions that use it, in place of two private copies per session (`assigned-mcp-tools.ts:146`) | server memory per live or warm session from about 5–11 MB (measured at 400–800 tools) to near zero; at 1,000 agents that is 5–11 GB |

### Background recovery sweeps

Run events used to send a company recovery hint, so the stranded-assignment
and assigned-work queues re-checked every open task of the company on each
run event (#21552). Local fixture: 1,500 open tasks, 60 agents, process agents
that fail at once, 180-second window that includes one 5-minute backstop pass.

| Build | Runs created (/s) | Stranded checks per window | Assigned-work checks per window | `agent_task_sessions` reads (/s) | Statements (/s) |
| --- | --- | --- | --- | --- | --- |
| Before #21552 (54c3616ad9) | 1.09 | 4,327 | 245 | 26.5 | 1,431 |
| #21552 at dcd170e29f | 1.00 | 702 | 276 | 7.2 | 1,060 |
| master at 340157d1d6 | 0.24 | 330 | 72 | 2.5 | 409 |

The master row has much less run churn than the earlier rows, so compare the
per-window totals with care. In that window the one backstop pass loaded 260
tasks into the stranded queue; run events loaded 147.

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
| 3 | Order of work: Phase 1 before Phase 2 | yes; at today's cost one process saturates between 100 and 150 agents in the load model, and near 50 on a hosted server |

## Not verified

- The load model runs on loopback PostgreSQL on a developer machine. It
  measures the modelled sources only and has no hosted round-trip time.
- The first tables used assumed rates (20 deltas/s, 1 other event/s). The
  "Load model at recorded rates" section uses rates from recorded hosted runs;
  the API rate (0.3/s) is still an assumption.
- Staging's pool size and run-log storage mode were not read.
- Tool-gateway calls, recovery sweeps, and browser fan-out are not in the
  model.
