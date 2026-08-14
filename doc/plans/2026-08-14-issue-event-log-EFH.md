# Issue event-log cluster (E → F → H) — implementation scope

> Status: **SCOPE / DESIGN — no code until approved.** Part of the bb Tier-2 mining
> backlog (see the vault Decision note "bb is a cockpit not a control plane"). Tier-1
> A (`run watch`) and B (`once` triggers) already shipped on `trev/bb-tier1-live-ops`.
> This document scopes the strategic cluster that makes live-follow/steer real.

## Why this cluster

bb's cockpit advantage rests on one primitive: a **thread is a single typed,
append-only, replayable event stream**, and every surface (desktop/web/CLI/API)
tails the same stream gap-free. Paperclip has all the parts but wired differently:

- Per-**run** durable event log **already exists** — `heartbeat_run_events`
  (`packages/db/src/schema/heartbeat_run_events.ts`): `(runId, seq)` indexed,
  `bigserial id`, `eventType/stream/level/message/payload`. This is what Tier-1 A
  tails via `GET /api/heartbeat-runs/:runId/events?afterSeq=`.
- Per-**issue** history is **re-derived on every read** from **6 tables** by
  `server/src/services/work-timeline.ts` — `issues`, `heartbeatRuns`, `activityLog`,
  `issueComments`, `issueThreadInteractions`, `issueApprovals` (UNION-and-sort at
  L217–295 detail / L331–391 + L549–608 paged). No durable ordering, no cursor.
- The live bus is an **in-memory `EventEmitter`** (`server/src/services/live-events.ts`)
  behind the WS at `/api/companies/:id/events/ws`
  (`server/src/realtime/live-events-ws.ts`). **No replay** — a reconnect drops
  whatever was emitted while disconnected.
- The UI already reconciles WS + poll by seq
  (`ui/src/components/transcript/useLiveRunTranscripts.ts`) and carries a standing
  `TODO(perf)` (L16–24): *demote the poll to a slow safety-net once realtime is
  reliable.* It cannot, because the WS has no gap-free guarantee.

So the cluster is: **E** give issues the same durable append-only log runs already
have; **F** make the WS replay from it (gap-free reconnect); **H** stream at
message/tool granularity and let the UI trust the stream. E is the foundation; F
and H depend on it.

---

## E — unified append-only per-issue event log  *(FOUNDATION)*

**Goal.** One durable, ordered, typed stream per issue, replacing the 6-table
re-derivation as the *read + subscribe* source of truth. Copy the two patterns
that already exist in-repo rather than invent one.

**Copy targets (do not design from scratch):**
- `heartbeat_run_events` — the `(scopeId, seq)` + `bigserial id` + `payload jsonb`
  replay shape. This is the one F needs.
- `case_events` (`packages/db/src/schema/cases.ts:81`) — the
  `kind` CHECK-constraint + `actorType in ('user','agent','system')` +
  `actor_user_id`/`actor_agent_id` + `(scopeId, createdAt)` index shape.

**Proposed table `issue_events`** (new, additive — no existing table changes):

| column | type | note |
|---|---|---|
| `id` | `bigserial` PK | monotonic global cursor (like heartbeat_run_events) |
| `company_id` | uuid NN → companies | company-scoped (AGENTS.md) |
| `issue_id` | uuid NN → issues (cascade) | the stream key |
| `seq` | integer NN | per-issue monotonic; unique `(issue_id, seq)` |
| `kind` | text NN | CHECK-constrained event vocabulary (see below) |
| `actor_type` | text NN | CHECK `in ('user','agent','system')` |
| `actor_user_id` | text NULL | mirror case_events |
| `actor_agent_id` | uuid NULL → agents (set null) | |
| `run_id` | uuid NULL → heartbeat_runs (set null) | links a message/tool event to its run |
| `payload` | jsonb NN default `{}` | typed per `kind` in shared |
| `created_at` | timestamptz NN default now | |

Indexes: unique `(issue_id, seq)`; `(company_id, issue_id)`; `(company_id, created_at)`.

**Event vocabulary (v1 `kind`s)** — the union of what work-timeline currently
re-derives, so E is a superset from day one: `status_changed`, `run_started`,
`run_finished`, `run_event` (message/tool granularity — the H payload),
`comment_added`, `thread_interaction`, `approval_requested`, `approval_resolved`,
`blocker_added`, `blocker_cleared`, `assignee_changed`. Frozen as a
`z.enum`/CHECK pair in `packages/shared` + the DB, kept in sync (AGENTS.md
contract rule).

**Write path.** A single `appendIssueEvent(tx, {...})` helper that allocates the
next per-issue `seq` inside the same transaction as the state change that caused
it (status write, comment insert, run status transition, approval, blocker).
Call it from the ~6 existing mutation sites — `issues`, `heartbeat`, `activity`,
`issueComments`, `issueThreadInteractions`, `issueApprovals` services. This is
the bulk of E's work and its main risk (every mutation path must append, or the
log silently under-reports).

**Read path.** `work-timeline.ts` becomes a thin reader over `issue_events`
(ORDER BY seq) instead of a 6-way UNION. **Keep the UNION as a one-time backfill**
to seed history for existing issues (migration data step), then retire it as the
live source.

**Migration (the deliberate schema exception — checkpoints, per CLAUDE.md):**
1. `pnpm db:generate` the additive `issue_events` table only. Review generated SQL.
2. Ship the write path behind a flag; **dual-write** (append events *and* keep the
   6 source tables authoritative) for one release. Verify parity: for N sample
   issues, `issue_events`-derived timeline == current work-timeline output.
3. Backfill historical events from the UNION (idempotent, resumable).
4. Flip `work-timeline` reads to `issue_events`. Keep dual-write until F/H land.

**Effort: M–L · Risk: Med** (append-at-every-mutation completeness). Blocks F, H, and later J (fork/side-chat).

---

## F — replayable WS cursor (gap-free reconnect)  *(dep: E)*

**Goal.** A reconnecting client resumes exactly where it left off — no dropped
events, no dupes.

**Change.** In `live-events-ws.ts`, accept a resume cursor (`?afterSeq=` query
and/or the standard `Last-Event-ID` header). On connect: **backfill from
`issue_events` (or `heartbeat_run_events` for run-scoped subscriptions) after the
cursor, THEN attach the in-memory `EventEmitter` listener** — buffering anything
that arrives during backfill and flushing in order (the exact subscribe-then-
replay pattern Tier-1 A's `watchRun` already implements client-side in
`cli/src/commands/client/run.ts`; F moves that guarantee server-side so every
surface gets it for free). Retire the in-process `nextEventId` as the ordering
source in favor of the durable `id`/`seq`.

**Effort: M · Risk: Med.** Self-contained once E exists. Verify: kill the socket
mid-run, reconnect with the last seq, assert zero gaps and zero dupes.

---

## H — message/tool-granularity live feed + retire the transcript poll  *(dep: E)*

**Goal.** Stream fine-grained deltas (each message / tool call) over the live bus,
and let the UI treat the stream as primary (poll → slow safety-net).

**Change.**
- Server: `publishLiveEvent` on every `issue_events` append of `kind:'run_event'`
  (and status/comment kinds), not just `heartbeatRunStatus`. The payload already
  exists at run granularity in `heartbeat.ts`.
- UI: `useLiveRunTranscripts.ts` already dedupes WS-vs-log by seq and *wants* to
  demote the poll (its `TODO(perf)` L16–24). With F guaranteeing gap-free
  delivery, change the poll `refetchInterval` to a slow fallback and make the WS
  the primary source.

**Effort: S–M · Risk: Low.** Mostly wiring on top of E + F. Verify: a run's
tool calls appear in the UI within one WS round-trip with the poll disabled.

---

## Recommended order & gating

```
E (foundation, dual-write + backfill)  ──►  F (server-side replay)  ──►  H (fine-grained feed + poll demotion)
```

1. **E first, dual-write, prove parity before flipping reads.** Do not delete the
   6-table UNION until F and H are green — it is the safety net and the backfill source.
2. **F next** — smallest, self-contained, immediately makes Tier-1 A and the UI
   reconnect-safe.
3. **H last** — cheap once E+F exist; delivers the visible cockpit win.

**Out of scope here** (later backlog items, do not fold in): G (per-issue runner
override), J (fork/side-chat — depends on E), true synchronous mid-run steering
(architecture change, ACP/streaming adapters only).

## Verification floor (every step)

- `pnpm --filter @paperclipai/shared build` then `-r typecheck`.
- `pnpm --filter @paperclipai/server exec vitest run` on the touched service
  suites (`work-timeline-service.test.ts`, per-mutation service tests).
- Parity assertion (E step 2) as a test: derived timeline == UNION timeline.
- Gap/dupe assertion (F) and poll-off delivery assertion (H) as tests.
- Company-scoped throughout; contracts synced db ⇄ shared ⇄ server ⇄ ui (AGENTS.md).

## Open questions (resolve before E code)

1. **Comment/approval bodies**: does `issue_events.payload` embed them, or carry
   only a reference into the source table? (Embed = simpler reads, more storage /
   duplication; reference = leaner, an extra join.) Lean embed-a-summary + reference.
2. **`seq` allocation** under concurrent appends to one issue: advisory lock on
   `issue_id`, or `INSERT ... RETURNING` off a per-issue counter? heartbeat_run_events'
   existing approach is the precedent to copy.
3. **Backfill seq ordering** for historical rows with only `created_at`
   (ties broken how?).
