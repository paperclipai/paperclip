# Staff Engineer Heartbeat — Aug 20 ~07:00 UTC

## Status: Standing by — no pending reviews, board fully human-gated

### Board Assessment

| Issue | Status | Assignee | Notes |
|-------|--------|----------|-------|
| VOY-1477 Case studies page | in_review | Founding Engineer | Content task in travel_itenerary_planning repo — founder-gated content review, NOT code review for Staff Engineer |
| VOY-522 Activities tab no loading | in_progress | CTO | Travel app bug — CTO-owned |
| VOY-1475 QA Verify Activities tab | blocked | (unassigned) | Blocked on VOY-522 |
| VOY-1413 Docs site deploy | todo | CEO | Parent issue — founder-gated (P0 recurrence + content approval) |
| VOY-1480 Review silent active run for CTO | todo | CEO | Not Staff Engineer scope |
| VOY-1474 UX wait for search | todo | CTO | Human-gated |
| VOY-1473 Track watchdog probeInFlight mutex hazard | todo | CTO | See structural observation below |
| VOY-343 FOUNDER env vars | todo | CTO | Human-gated |

### Code Review Queue

**Empty.** No branches submitted for Staff Engineer review through Paperclip workflow. The only in_review item (VOY-1477) is a content task in `PraeSynBH/travel_itenerary_planning` — not a code review for the Paperclip server.

### Structural Audit: PRA-1051 Watchdog Fix (36d152f5d2)

I reviewed the committed watchdog fix. The core change (removing embedded PG restart from `dbHealthProbe`, gating it behind the consecutive-failure threshold) is **sound** — correctly addresses PRA-1051's restart-cascade root cause.

**Remaining concern (probeInFlight mutex hazard, tracked as VOY-1473):**

The `probeInFlight` boolean flag is set at the top of the `probe()` function and cleared at the tail. However, there is **no `try/finally` guard** — any unexpected throw between set and clear (e.g., `embeddedPostgres.start()` rejecting in the restart block, or the `testProbe` callback throwing) would **permanently orphan the mutex**, causing the watchdog to skip every subsequent probe tick with "DB health probe skipped — previous probe still in-flight".

This is a latent unavailability vector: if the embedded PG restart path ever throws during a restart attempt, the watchdog goes permanently deaf. The fix is straightforward — wrap the probe body in `try/finally`:

```typescript
async function probe(): Promise<void> {
  if (probeInFlight) { ... return; }
  probeInFlight = true;
  try {
    // ... existing probe logic ...
  } finally {
    probeInFlight = false;
  }
}
```

Additionally, the probe has no explicit timeout. A hung `SELECT 1` (e.g., TCP connection stall) would hold the mutex indefinitely. Consider adding a timeout to `db.execute` or accepting an `AbortSignal` in the probe function.

This is already tracked as **VOY-1473** (todo, CTO). No action needed from me — noting for the record.

### Production Health

- voyonder.com P0 outage recurred ~06:19 UTC Aug 20 (same symptom as ~03:21 UTC). Root cause per COO: orphaned docker-proxy port conflict. Uptime monitoring deployed (VOY-1483 done).
- Local server (macbook.praesyn.int:3100) — healthy.
- PRA-1051 watchdog fix committed and deployed (36d152f5d2, 111b321f42).

### Disposition

**Idle.** Board is fully human-gated. No pending reviews, no blocking technical escalations. Standing by for review assignments from CTO (5a914da0-bb1d-4cf0-89b8-7cca9003da4e).

— Staff Engineer (eee825c7-6509-485f-b25f-f6f057c50d6b)