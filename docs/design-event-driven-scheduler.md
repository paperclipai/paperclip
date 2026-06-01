# Design: event-driven scheduler (NOTIFY/LISTEN)

**Status:** proposal
**Author:** mrleepee fork (round-2)
**Audience:** paperclipai maintainers
**Companion:** `packages/plugins/plugin-event-waker` (already shipped on `feat/plugin-event-waker`)

## Goal

Replace the `setInterval` poll loop in `services/heartbeat.ts` with a Postgres
NOTIFY/LISTEN-driven scheduler. Wakes fire on the event that triggered them
(issue PATCH, routine fire, wakeup-request insert) instead of every 10 seconds.
Falls back to a much-longer-period tick (60 s) as a safety net for missed
events.

The intent is **lower latency** (sub-second wake propagation) and **lower
idle cost** (no scan when there's nothing to do).

## Why now

Round 1 (already shipped on `feat/scheduler-tuning`):

- Lowered `HEARTBEAT_SCHEDULER_INTERVAL_MS` default 30 s → 10 s.
- Added per-agent exponential backoff to stop stuck-credentials agents
  from hammering Bedrock.

Both are tuning. The poll loop itself is the next bottleneck. At 10 s the
average wake latency is 5 s + DB scan + adapter cold-start; we want sub-
second on actual transitions.

## Constraints discovered

From the round-2 discovery workflow (`wf_57a1ded5-73e`):

- **Postgres pub/sub is available** — embedded postgres ships with full
  NOTIFY/LISTEN support; no extension required.
- **The current scheduler runs every 10 s**, calls `tickTimers(now)` and
  `tickScheduledTriggers(now)` and a handful of recovery passes.
- **Trigger sources are already enumerated** in code (`schedule`, `manual`,
  `api`, `webhook`, `timer`, `issue-monitor`, `scheduled-retry`,
  `wakeup-request`). The scheduler's job is to find which of these are due
  and dispatch them.
- **There is no existing `LISTEN` consumer** in the codebase — this is
  greenfield.

## Design

### 1. Database triggers

Three Postgres triggers, one per table that originates a wake-worthy event:

```sql
-- migration 0093_event_scheduler_triggers.sql

CREATE OR REPLACE FUNCTION pcl_notify_issue_change() RETURNS trigger AS $$
DECLARE
  payload jsonb;
BEGIN
  -- Build a small payload — never put the full row, the listener fetches it
  payload := jsonb_build_object(
    'kind', 'issue',
    'op', TG_OP,
    'companyId', COALESCE(NEW.company_id, OLD.company_id),
    'issueId', COALESCE(NEW.id, OLD.id),
    'prevStatus', OLD.status,
    'currStatus', NEW.status,
    'prevAssignee', OLD.assignee_agent_id,
    'currAssignee', NEW.assignee_agent_id
  );
  PERFORM pg_notify('paperclip_events', payload::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER issues_event_notify
  AFTER INSERT OR UPDATE OF status, assignee_agent_id ON issues
  FOR EACH ROW EXECUTE FUNCTION pcl_notify_issue_change();

-- analogous functions for routine_triggers (after UPDATE next_run_at)
-- and agent_wakeup_requests (after INSERT)
```

**Channel:** one shared channel `paperclip_events` keeps the LISTEN connection
count to 1. Multi-channel sharding is a follow-up if event volume warrants.

**Payload size cap:** Postgres NOTIFY payload is 8000 bytes. Our payloads are
hundreds of bytes — fine. The listener fetches the full row only if it needs
to act.

### 2. LISTEN consumer

New file: `server/src/services/event-scheduler-listener.ts`.

```ts
import { Client } from "pg";

export function startEventSchedulerListener(opts: {
  databaseUrl: string;
  onEvent: (event: PaperclipEvent) => Promise<void>;
  logger: Logger;
}) {
  const client = new Client({ connectionString: opts.databaseUrl });
  let alive = true;

  async function connect() {
    await client.connect();
    await client.query("LISTEN paperclip_events");
    opts.logger.info("event-scheduler-listener subscribed", { channel: "paperclip_events" });
  }

  client.on("notification", async (msg) => {
    if (msg.channel !== "paperclip_events" || !msg.payload) return;
    try {
      const event = JSON.parse(msg.payload) as PaperclipEvent;
      await opts.onEvent(event);
    } catch (err) {
      opts.logger.error("event-scheduler-listener parse/dispatch failed", { err });
    }
  });

  client.on("error", (err) => {
    opts.logger.error("event-scheduler-listener pg error", { err });
    if (alive) reconnect();
  });

  async function reconnect() {
    try {
      await client.end();
    } catch {}
    if (!alive) return;
    setTimeout(connect, 1000);
  }

  void connect();

  return {
    stop: async () => {
      alive = false;
      await client.end();
    },
  };
}
```

The dispatch handler maps event kinds to existing scheduler entry points:

```ts
async function onEvent(event: PaperclipEvent) {
  switch (event.kind) {
    case "issue":
      // mirror what tickTimers does for one issue: enqueueWakeup if
      // (status, assignee) transition matches a wake-worthy pattern
      await maybeWakeAssignee(event);
      break;
    case "routine":
      await routinesService.tickScheduledTrigger(event.routineTriggerId);
      break;
    case "wakeup-request":
      await heartbeat.dispatchWakeupRequest(event.requestId);
      break;
  }
}
```

### 3. Backwards-compatible fallback tick

Keep the existing setInterval loop, but at a much longer period:

```ts
// Round-2 default: 60s if event-scheduler is enabled, 10s if not.
const FALLBACK_INTERVAL_MS = config.eventSchedulerEnabled
  ? 60_000
  : config.heartbeatSchedulerIntervalMs;
```

If the LISTEN connection drops or a NOTIFY is missed (rare but possible —
NOTIFY is best-effort under Postgres recovery edge cases), the fallback
catches it within 60 s. We instrument both paths so we can measure how
often the fallback finds work the listener missed; if that's near zero
after a week of running, drop the fallback to 5 min.

### 4. Migration plan

1. **Behind a flag.** New env `EVENT_SCHEDULER_ENABLED=false` (default off).
   Both the listener AND the long-period fallback start when the flag is on.
   When off, no listener, normal 10 s tick — current behaviour preserved.

2. **Test in shadow mode first.** Add a counter:
   `event_scheduler.fired_by_listener` and `event_scheduler.fired_by_fallback`.
   If the fallback ever finds work the listener should have caught, log the
   missed event with full payload for triage.

3. **Default on after one week** of running with the flag and zero missed
   events. At that point we can also tighten the fallback period.

4. **Rollback:** flip the flag off. The triggers stay in place (they're
   harmless when no listener is running — `pg_notify` to a channel with no
   listeners is a no-op).

### 5. What we're NOT doing in this MR

- **Not** removing the existing `tickTimers` / `tickScheduledTriggers`. They
  become the fallback branch. Future refactor can extract their dispatch
  logic so the listener and the fallback share it; not now.
- **Not** adding multi-channel sharding. The 8000-byte cap is plenty for one
  channel at SF-R volume (~30 wake-worthy events per day).
- **Not** changing the routine-cron evaluator. `tickScheduledTriggers` still
  runs on the fallback tick to catch anything the trigger-on-update missed.

## Tradeoffs

| | Polling (current) | Event-driven (proposed) |
|---|---|---|
| Wake latency on issue PATCH | ~5 s avg | sub-second |
| Idle CPU/DB | constant 1 query/10 s | zero between events |
| Implementation cost | already there | ~half-day code + 1 schema migration |
| Failure modes | scan errors are visible | missed NOTIFY (rare), connection drops |
| Observability | every tick logs | needs counters to prove correctness |

The dominant tradeoff is the missed-NOTIFY risk. Mitigated by the fallback
tick. Acceptable for round-2 — round-3 could add idempotent
"resync-from-last-event-id" semantics if we see real misses.

## Effort

**Half-day** for the code + migration + test. Add ~1 day for shadow-mode
observation before flipping the default.

## Risks

- **Reconnect storms.** If the embedded postgres restarts under load, the
  listener will reconnect — guard with exponential backoff inside
  `event-scheduler-listener.ts`.
- **pg-bouncer / connection pooler.** Not relevant for embedded postgres in
  the local-board deployment, but if anyone runs Paperclip behind pgbouncer
  the listener needs `session` mode (LISTEN doesn't survive transaction
  pooling). Document this.
- **Trigger overhead under high write load.** At SF-R volume (~10 issue
  writes/min) the trigger cost is negligible. At fleet-of-100-companies
  scale it'd want measurement.

## Rollback plan

1. `EVENT_SCHEDULER_ENABLED=false` (env flag) — instant fallback to current
   behaviour.
2. If the triggers themselves cause issues, drop them:
   `DROP TRIGGER issues_event_notify ON issues;` (single statement, no data
   change).
3. The migration is additive — no rollback migration needed.

## Companion: plugin-event-waker

The `packages/plugins/plugin-event-waker` plugin (shipped on
`feat/plugin-event-waker`) is a **userspace** version of this design — it
subscribes to `issue.updated` events from the existing in-process event bus
(`publishLiveEvent`) and wakes the assignee. It's the right shape for
plugin authors who want event-driven behaviour without touching the core
scheduler.

This server-side design is the **infrastructure** version: it makes the
scheduler itself event-driven, which means the plugin and the core
heartbeat work the same way. Either can ship first; they don't conflict.
