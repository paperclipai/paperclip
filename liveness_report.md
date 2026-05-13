# Liveness & Recovery Subsystem Report

Generated: 2026-05-12
Status: Assessment for next hardening target

---

## Current Architecture

### Core liveness services

| Service | File | Purpose |
|---------|------|---------|
| Run Liveness | `server/src/services/run-liveness.ts` | Classifies run health: `runnable`, `manager_review`, `blocked_external`, `approval_required`, `unknown` |
| Heartbeat | `server/src/services/heartbeat.ts` | 30s heartbeat tick; manages run lifecycle, continuation summaries, workspace operations |
| Recovery Service | `server/src/services/recovery/service.ts` | Stranded issue recovery, stale active run evaluation, issue-graph liveness |
| Run Continuations | `server/src/services/recovery/run-liveness-continuations.ts` | Bounded retry decisions (max 2 attempts) for `plan_only` and `empty_response` liveness states |
| Issue Graph Liveness | `server/src/services/recovery/issue-graph-liveness.ts` | Detects and recovers stale issue trees |
| Pause Hold Guard | `server/src/services/recovery/pause-hold-guard.ts` | Prevents auto-recovery during pause holds |

### Key thresholds

| Parameter | Value | Source |
|-----------|-------|--------|
| Heartbeat interval | 30,000ms | `heartbeat.ts` |
| Suspicion threshold (no output) | 1 hour | `recovery/service.ts` |
| Critical threshold (no output) | 4 hours | `recovery/service.ts` |
| Continuation rearm window | 30 minutes | `recovery/service.ts` |
| Max continuation attempts | 2 | `run-liveness-continuations.ts` |
| Issue-graph auto-recovery staleness | 24 hours | `recovery/service.ts` |
| Evidence tail capture | 8 KB | `recovery/service.ts` |

### Liveness states

Run liveness classification produces: `healthy`, `plan_only`, `empty_response`, `stalled`, `errored`, `timed_out`, `unknown`.

Actionable states for continuation: `plan_only`, `empty_response` only.

### Startup recovery

On server start, `reconcilePersistedRuntimeServicesOnStartup()` promotes scheduled retries, requeues continuations, and detects orphan blockers. Observed in startup logs:
```
promotedScheduledRetries: 0
continuationRequeued: 1
orphanBlockersAssigned: 0
escalated: 0
skipped: 101
```

---

## Identified Gaps

### 1. No proactive alerting
Liveness detection is passive — it runs on heartbeat ticks and startup reconciliation. There is no push notification or webhook for stuck runs. Detection relies on the next heartbeat cycle or server restart.

### 2. Continuation decisions are count-based only
Max 2 attempts prevents unbounded loops but does not detect semantic repetition. Two consecutive `empty_response` runs with identical error signatures are treated as independent attempts.

### 3. 24-hour staleness window for issue-graph recovery
`ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_MIN_STALE_MS = 24h` is conservative. An issue tree could be stuck for nearly a full day before auto-recovery engages.

### 4. No liveness coverage for QSL subsystem
QSL scan and review operations run outside the heartbeat system. A stuck QSL scan or bridge sync has no liveness detection. This is acceptable at current scale but becomes a gap as QSL integrates more deeply.

---

## Recommendation: Safest Next Hardening Target

**Liveness/deadlock hardening** (GR-002) is the safest and highest-value next target.

### Rationale

1. **Isolated blast radius.** Liveness classification and continuation logic are self-contained in `server/src/services/recovery/`. Changes do not touch routing, adapter registry, or workspace provisioning.
2. **Already instrumented.** Evidence collection, run status tracking, and heartbeat infrastructure are all in place. Hardening means improving decision quality, not building new infrastructure.
3. **Low regression risk.** Liveness changes affect recovery behavior, not the happy path. A bug in liveness detection causes a missed recovery, not data corruption.
4. **Prerequisite for provider routing.** Provider routing changes depend on reliable stuck-state detection. Hardening liveness first makes routing changes safer.
5. **Concrete deliverables:**
   - Add output-similarity guard to `decideRunLivenessContinuation()`
   - Reduce issue-graph staleness window or add tiered escalation
   - Add structured liveness alerts (log-based or webhook)
   - Validate continuation-loop guards under concurrent-run scenarios

### What NOT to do next

- **Provider routing changes** — depends on liveness hardening being complete (GR-006)
- **Data confidence classification** — useful but lower priority than operational safety
- **Backup/recovery validation** — important but lower blast-radius risk than liveness gaps
