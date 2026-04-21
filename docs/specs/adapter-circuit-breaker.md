---
title: Adapter-Level Circuit Breaker and Quarantine
summary: Isolate a failing adapter so one bad adapter cannot wedge the entire fleet
---

# Adapter-Level Circuit Breaker and Quarantine

**Issue:** CLI-121
**Parent:** CLI-75 (fleet outage postmortem, 2026-04-20)
**Status:** Approved (v4) — ClippyQA + ClippyArch + ClippyEng review complete; ready for implementation sub-tickets

**Revision history:**
- v1 — initial draft (ClippyArch, 01:39 UTC).
- v2 — rubber-duck design review, 10 substantive findings folded (two-shape keying, Open=DEFERS, probe CAS lease, failure classification, etc.).
- v3 — QA spec review @ 02:32 UTC: 3 acceptance gaps closed, 2 §-level clarifications, 2 minor hardenings (this revision).
- v4 — Eng implementation-binding addendum: classify thrown startup/config failures in heartbeat catch paths, preserve `errorCode` as operator/UI surface, and reset re-trip halving after a stable Closed window.

## Problem

On 2026-04-20 06:59 UTC, a single `copilot_local` adapter failure stranded 8 of 9 agents in `status=error` for ~19 minutes and auto-blocked 30+ in-flight issues. Every agent bound to that adapter hit the same `adapter_failed - Process adapter missing command` on its next heartbeat, and there was no mechanism to *isolate* the bad adapter from the rest of the fleet while recovery ran.

The CLI-75 follow-ups shipped detection (CLI-77), gating (CLI-79), and alerting (CLI-84). **This spec covers the missing axis: isolation.** A failing adapter should fail in place without consuming the fleet.

## Non-goals

- Not a retry/back-off policy for individual heartbeats (that lives in the execution loop).
- Not a replacement for CLI-79 release-channel gating; this kicks in *after* a bad adapter is already live.
- Not a cross-adapter failover (we do not migrate agents from `copilot_local` → `codex_local` automatically).

## Design

### 1. Failure accounting

For each `adapterType` (e.g., `copilot_local`), the server maintains a rolling window of adapter-layer failures:

- **Counted:** `adapter_failed`, missing-command errors, adapter-bootstrap timeouts, probe timeouts (`adapter_probe_timeout`), and any error classified as originating in the adapter itself (not the agent run).
- **Not counted:** agent-side errors (tool call failures, run-timeouts inside the agent, non-zero exits surfaced as run output).

Classification uses a breaker-only `adapterFailureReason` signal on `AdapterExecutionResult`, or an equivalent `classifyAdapterFailure(err, adapterType)` path in heartbeat for thrown startup/config failures. `errorCode` remains the operator/UI surface so existing run UX (for example, auth-specific CTAs keyed off adapter error codes) does not regress. This is binding on implementation: the heartbeat catch paths that currently flatten thrown startup failures to plain `adapter_failed` must classify those throws so `process adapter missing command` / `http adapter missing url`-class failures count toward the breaker.

### 2. Trip conditions

The breaker trips for an `adapterType` when either:

- **Burst:** ≥ `N_burst` adapter-origin failures across distinct agents within `T_burst` seconds (defaults: `N_burst=3`, `T_burst=60s` — matches the CLI-84 alert threshold so alert-fires-and-breaker-trips-together by default).
- **Sustained:** ≥ `N_sustained` adapter-origin failures in `T_sustained` (defaults: `N_sustained=10`, `T_sustained=600s`) — catches slower-rolling outages that would miss the burst window.

Both thresholds are configurable per adapter type via server config (see §6).

### 3. Quarantine state

When the breaker trips for `adapterType=X`:

1. Mark the adapter type `quarantined` in server state, with `quarantinedAt`, `tripReason`, and `tripEvidence` (the last N failure records).
2. For every agent whose current adapter is `X`, transition them to a **new** status `quarantined` (not `error`). Distinction matters:
   - `error` = agent-specific failure, operator investigates this agent.
   - `quarantined` = agent is fine, its adapter is not; no per-agent investigation required.
3. Issues assigned to quarantined agents are **not** auto-blocked. They retain their current status with a `quarantineHold` flag on their execution record. This avoids the CLI-75 secondary symptom where 30+ issues flipped to blocked and required manual rehydration.
4. Emit a single `adapter.quarantined` event (distinct from the per-agent `adapter_failed` events) so alerting/dashboards can show one row, not N.

**Assignment to a quarantined agent (QA gap #3).** New issue assignment to an agent whose current adapter circuit is Open is **permitted** and stamps `quarantineHold=true` on the execution record at assignment time (no run is started). The first wake is deferred to the circuit's `resumeAt`, and the hold is visible in UI. Rationale: blocking assignment would flip the failure mode back to "fleet stalls on assignment," which is exactly what quarantine is designed to avoid.

### 4. Release (two paths)

The breaker releases `X` when **either**:

- **Automatic probe-based release.** A background health probe runs every `probeIntervalSec` (default `30s`) and executes the adapter's `healthCheck()` (new required adapter method; see §5). After `probeSuccessCount` consecutive successes (default `3`), the breaker releases automatically. Agents transition `quarantined → idle` and resume on their next heartbeat.
- **Manual operator reset.** A board-operator-only admin reset clears quarantine immediately, optionally with `force=true` to skip probe confirmation. If the quarantined adapter is an override of a builtin adapter, resuming the override via the existing override-pause route is also a Closed transition. Release emits `adapter.quarantine_released` with `releasedBy` and `reason`.

On release, the trip counters reset **and** every `quarantineHold=true` flag belonging to issues bound to adapter `X` is cleared in the same transaction (QA gap #2). This applies to probe-based release, admin reset, and override-pause resume. The next agent heartbeat for those issues then resumes normal execution via the existing `deferred_issue_execution` re-promotion loop; no manual rehydration or new wake path is needed. If the breaker trips again within `reTripGraceSec` (default `120s`), the trip thresholds are halved for the next window — repeated flapping should escalate, not silently cycle. If the breaker remains Closed for `>= reTripGraceSec` without a re-trip, thresholds reset to their configured defaults.

### 5. Adapter contract changes

Every adapter gains a required method:

```ts
interface Adapter {
  // ...existing methods
  healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult>;
}

interface HealthCheckResult {
  ok: boolean;
  reason?: string;       // human-readable, logged with quarantine events
  details?: unknown;     // structured, surfaced in admin UI
}
```

Semantics:

- MUST NOT spawn a full agent run. Lightweight only (e.g., `copilot --version`, SDK connectivity check, `which` on the adapter's configured `command`).
- MUST respect `ctx.timeoutMs` (default `5000`). A hung probe counts as `adapter_probe_timeout`, and a timeout **and** an explicit `{ ok: false }` return are weighted equally as probe failures (QA minor #2). Both reset `probeSuccessCount` and count toward the next trip evidence.
- MUST be idempotent and side-effect-free.

For built-ins, the work is small (copilot_local: reuse the CLI-77 adapter-health-probe check; process: verify `command` resolves; http: HEAD/GET against the configured URL). External adapters get a one-release deprecation window where a missing `healthCheck` degrades to "probe unavailable → manual release only" rather than breaking the plugin.

### 6. Configuration

New server config section (env + config file):

```yaml
adapters:
  circuitBreaker:
    enabled: true                  # global kill-switch
    defaults:
      nBurst: 3
      tBurstSec: 60
      nSustained: 10
      tSustainedSec: 600
      probeIntervalSec: 30
      probeSuccessCount: 3
      reTripGraceSec: 120
    overrides:
      copilot_local:
        nBurst: 3                  # same as default; explicit for the adapter that caused CLI-75
```

Env vars mirror the defaults: `PAPERCLIP_ADAPTER_BREAKER_ENABLED`, `PAPERCLIP_ADAPTER_BREAKER_N_BURST`, etc.

### 7. Observability

- `adapter.quarantined` event: `{adapterType, trippedAt, reason, evidence}`.
- `adapter.quarantine_released` event: `{adapterType, releasedAt, releasedBy, mode: "probe"|"manual"}`.
- `GET /api/adapters/quarantine` returns current quarantine state for all adapter types.
- Dashboard: a banner on the agent-fleet view when any adapter is quarantined, listing affected agents.
- Run/stop summarization must preserve `adapter_quarantined` as distinct from `adapter_failed`; dashboards must not collapse the two states.
- Metrics: `adapter_quarantine_trips_total{adapter_type}`, `adapter_quarantine_duration_seconds{adapter_type}`, `adapter_health_probe_failures_total{adapter_type}`.

### 8. Interaction with CLI-84 alerts

The CLI-84 alert fires when ≥3 agents hit `adapter_failed` within 60s. With this breaker active and using default thresholds, the alert and the trip fire on the same evidence. Recommend: the alert payload includes `quarantined: true|false` so on-call can see at a glance whether isolation already kicked in and whether a human response is still required.

### 9. Interaction with CLI-91 actor-trust

Quarantine release is a state-changing action. It MUST honor the CLI-91 default-deny actor-trust rule: only `"user"` actors can trigger manual reset or override-pause resume. **Agent actors are explicitly forbidden** from triggering either path, including `force=true` (QA minor #1) — a compromised agent must not be able to lift its own quarantine. Rejected attempts still write an audit row. Probe-based automatic release is permitted because the probe itself is a first-class trusted signal, not an actor-authored comment.

## Failure modes and mitigations

| Failure | Mitigation |
|---|---|
| `healthCheck` gives false positives (returns ok while adapter is broken) | Require `probeSuccessCount=3` consecutive passes; log probe results; operator can force-quarantine via API. |
| `healthCheck` gives false negatives (never passes despite adapter being fine) | Manual `force=true` release path; probe result history visible in admin UI so operator can override. |
| Trip storm across every adapter type simultaneously | Global kill-switch (`enabled=false`); per-adapter overrides don't stack into a fleet-wide outage of the breaker itself. |
| External adapter plugin without `healthCheck` | Deprecation window: quarantine still works, but release is manual-only until the plugin updates. |
| Breaker trips during legitimate adapter upgrade | CLI-79 release-channel gating should prevent the new adapter from going live until canaries pass, so the breaker tripping during upgrade is a *signal*, not a bug. |
| Flapping adapter (trips, releases, re-trips) | `reTripGraceSec` halves thresholds on re-trip within the grace window, but resets to configured defaults after a stable Closed period of `>= reTripGraceSec` — escalates fast without degrading into a permanent hair-trigger. |

## Rollout plan

1. **Ship the `healthCheck` contract** (no-op breaker). Built-in adapters implement it; external adapters get a warning in the plugin log.
2. **Ship the breaker in shadow mode.** Trip conditions evaluated; events emitted; agent state **not** mutated. Run for one week; compare shadow trips against real-world adapter-origin failures to validate thresholds.
3. **Enable enforcement for `copilot_local` only.** The adapter that triggered CLI-75 is the first real beneficiary.
4. **Enable enforcement fleet-wide** after one clean week on `copilot_local`.
5. **Remove shadow-mode code path** after fleet-wide enforcement is stable for two weeks.

## Acceptance criteria

- [ ] `healthCheck` method added to the `Adapter` interface and implemented for every built-in adapter.
- [ ] Breaker trips on both burst and sustained conditions; unit tests cover both.
- [ ] `adapterFailureReason` (or equivalent heartbeat-side `classifyAdapterFailure`) is wired without changing operator/UI-facing `errorCode`, and both heartbeat catch paths classify thrown startup/config failures so `missing command` / `missing url` faults count toward the breaker.
- [ ] Quarantined agents transition to `quarantined` status (distinct from `error`); issues assigned to them are **not** auto-blocked.
- [ ] Automatic release after probe confirmation; manual release via API (gated to `user` actors per CLI-91).
- [ ] End-to-end test: simulate `copilot_local` adapter failure → verify breaker trips, agents move to `quarantined`, issues stay open with `quarantineHold`, probe restores → breaker releases → agents resume.
- [ ] **Re-trip threshold halving test (QA gap #1).** Trip → release → re-trip within `reTripGraceSec` → verify `nBurst`/`nSustained` are halved (rounded up) for the next window. Subsequent re-trip within grace halves again until floor of 1. Holding Closed for `>= reTripGraceSec` resets thresholds to configured defaults.
- [ ] **quarantineHold cleanup on release.** Unit test verifying that on probe-based release, manual reset, and override-pause resume, every `quarantineHold` flag for the released adapter type is cleared in the same transaction; assigned-while-quarantined issues then execute on next heartbeat via the existing deferred re-promotion loop.
- [ ] **Assignment-to-quarantined-agent.** Unit test: assigning a new issue while the circuit is Open succeeds, stamps `quarantineHold=true` at assignment time, and defers the first wake to `resumeAt` (no run started); release path then drains it.
- [ ] Dashboard/run summaries preserve `adapter_quarantined` as a separate stop reason rather than collapsing it into `adapter_failed`.
- [ ] Dashboard banner + `/api/adapters/quarantine` endpoint.
- [ ] Runbook entry in `docs/runbooks/` for "how to force-release / force-quarantine an adapter."
- [ ] Shadow-mode rollout validated with one week of data before enforcement.

## Open questions (resolved)

1. **Issue-level hold semantics.** ✅ **Surface in UI.** ClippyQA confirmed: an explicit "held — adapter quarantined" badge prevents "why is my ticket not moving" support noise. Internal-only is a support liability.
2. **Cross-project scope.** ✅ **Per adapter type for v1.** ClippyQA confirmed: the v2 two-shape keying already differentiates by module identity for shared-env adapters; revisit per-instance only if a real incident demands it.
3. **Healthcheck sampling cost.** Tracked but unresolved — `30s` probe interval × N adapter types is cheap for built-ins but could matter for external HTTP adapters. Revisit interval per-adapter if probes become a load issue. Not a blocker for v1.

## Follow-up tickets (to open after this spec is approved)

- Implementation ticket for the breaker core + `healthCheck` contract.
- Per-adapter `healthCheck` implementation tickets (one per built-in).
- Dashboard quarantine banner UI ticket.
- Runbook ticket for operator force-release/force-quarantine procedures.

## References

- CLI-75 postmortem: `docs/postmortems/2026-04-20-fleet-outage.md`
- CLI-77 adapter health probe (detection)
- CLI-79 adapter release-channel guardrail (gating)
- CLI-84 adapter fleet failure alert (alerting)
- CLI-91 deferred-wake reopen bug / actor-trust invariant
- CLI-122 adapter go-live checklist enforcement (sibling follow-up)
- CLI-123 actor-trust invariant spec (sibling follow-up)
