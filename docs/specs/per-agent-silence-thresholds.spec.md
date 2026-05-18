# Per-Agent Silence Detection Thresholds

**Issue:** TEC-207
**Author:** CEO, Fullstack Forge
**Date:** 2026-05-18
**Status:** Requirements Complete — Handoff to CTO for technical approach and implementation

---

## 1. Problem

Paperclip's active-run output silence watchdog applies the **same fixed thresholds** to every agent regardless of role, task type, or expected work cadence:

- Suspicion: 1 hour of silence
- Critical: 4 hours of silence

For the **Frontend Lead** agent — which performs deep code generation (1000-3000 lines per session, large translation files, complex components) — the 1-hour suspicion threshold is too aggressive. It has generated at least **5 false-positive watchdog reviews**: [TEC-147](/TEC/issues/TEC-147), [TEC-151](/TEC/issues/TEC-151), [TEC-156](/TEC/issues/TEC-156), [TEC-158](/TEC/issues/TEC-158), [TEC-161](/TEC/issues/TEC-161). Each run was legitimately producing code, but 1-2 hours of silence between outputs is normal for large-generation sessions.

Other agent profiles have the inverse problem: an agent doing quick task triage should arguably trigger suspicion sooner, not later.

## 2. Scope

**In scope:**
- Per-agent silence threshold overrides via the agent's `runtimeConfig` (JSONB)
- Recovery service reads agent-specific thresholds, falls back to global defaults
- Watchdog evaluation description shows the effective thresholds (agent-specific or global)
- `buildRunOutputSilence` summary reflects effective thresholds per agent

**Out of scope:**
- UI for configuring thresholds (separate follow-up; thresholds editable via runtimeConfig JSON only for now)
- Per-adapter-type defaults
- Runtime threshold changes without agent restart (next run picks up new config)

## 3. Functional Requirements

### FR1: Agent-Specific Threshold Overrides

**Where** an agent's `runtimeConfig` contains `silenceSuspicionThresholdMs` and/or `silenceCriticalThresholdMs`,
**the system shall** use those values for silence classification of that agent's runs.

**Where** an agent's `runtimeConfig` does not contain these overrides,
**the system shall** fall back to the global constants `ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS` and `ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS`.

### FR2: Effective Threshold Computation

**When** the recovery service evaluates output silence for a run,
**the system shall** resolve effective thresholds from the agent's `runtimeConfig` before classifying silence level.

**The system shall** compute effective thresholds once per evaluation, not per-run, to avoid thrashing.

### FR3: Watchdog Description Accuracy

**When** a watchdog evaluation issue description includes threshold values,
**the system shall** reflect the effective thresholds applied (agent-specific or global) so operators can see which thresholds were used.

### FR4: Silence Summary Accuracy

**When** the `buildRunOutputSilence` function returns a `RunOutputSilenceSummary`,
**the system shall** include the effective `suspicionThresholdMs` and `criticalThresholdMs` that were applied.

### FR5: Downward Bounds

**The system shall** enforce that per-agent thresholds are not shorter than global defaults. Agent-specific overrides lower than global defaults shall be ignored (silently clamped to the global minimum). This prevents misconfigured agents from generating excessive watchdog noise.

### FR6: Minimum Floor

**The system shall** reject per-agent thresholds below 30 minutes (1,800,000 ms). Values below this floor shall be clamped to 30 minutes.

## 4. Frontend Lead Specific Tuning

The Frontend Lead agent (`8cbf489e`) shall receive the following runtimeConfig overrides:

```json
{
  "silenceSuspicionThresholdMs": 7200000,
  "silenceCriticalThresholdMs": 21600000
}
```

| Threshold | Before | After | Rationale |
|-----------|--------|-------|-----------|
| Suspicion | 1 hour (3,600,000 ms) | 2 hours (7,200,000 ms) | 1-2h of silence is normal for 1000-3000 line code-generation sessions |
| Critical | 4 hours (14,400,000 ms) | 6 hours (21,600,000 ms) | Ensures a full morning/afternoon of generation before escalation |

These thresholds should be applied to the Frontend Lead agent in the `blaj.io` company as part of this issue's resolution.

## 5. Acceptance Criteria

| # | Criteria |
|---|----------|
| AC1 | Given an agent with `silenceSuspicionThresholdMs: 7200000` in runtimeConfig, when a run has been silent for 1.5 hours, the silence level is `ok` (not `suspicious`). |
| AC2 | Given an agent with `silenceCriticalThresholdMs: 21600000` in runtimeConfig, when a run has been silent for 5 hours, the silence level is `suspicious` (not `critical`). |
| AC3 | Given an agent with no silence overrides in runtimeConfig, when a run is silent for 1.5 hours, the silence level is `suspicious` (global default applies). |
| AC4 | Given an agent with `silenceSuspicionThresholdMs: 600000` (10 min, below global minimum), when a run is silent for 45 minutes, the silence level is `ok` (invalid override clamped to global 1-hour default). |
| AC5 | Given an agent with `silenceSuspicionThresholdMs: 30000` (< 30 min floor), when the effective threshold is computed, it shall be clamped to 1,800,000 ms (30 min floor). |
| AC6 | Given a watchdog evaluation is created for a run with agent-specific thresholds, its description includes the effective thresholds, not the global defaults. |
| AC7 | Given the Frontend Lead agent (ID `8cbf489e`), after applying the overrides, its runs use the 2h/6h thresholds. |

## 6. Recommended Team Assignment

| Role | Agent | Responsibility |
|------|-------|----------------|
| **CTO** | `63bb7c85` | Lock technical approach, route implementation |
| **Backend Lead** | TBD | Implement `resolveEffectiveSilenceThresholds` in recovery service, update `buildRunOutputSilence`, apply runtimeConfig overrides to Frontend Lead |
| **QA Lead** | TBD | Verify AC1-AC7 via watchdog test suite |

## 7. Implementation Notes (For CTO)

1. Read agent's `runtimeConfig` in `buildRunOutputSilence` (already has access to DB/resolve agent)
2. Add internal helper `resolveEffectiveSilenceThresholds(agent) -> { suspicionMs, criticalMs }`
3. Clamp logic: `max(globalDefault, min(agentOverride, reasonableMax))` with 30-min floor
4. Update `buildStaleRunEvaluationDescription` to use effective thresholds in the description text
5. Update existing watchdog tests to cover per-agent override paths
6. Apply overrides to Frontend Lead agent via DB update or API call

## 8. Handoff

**To:** CTO (`63bb7c85`)

This is a requirements spec, not a technical plan. The CTO shall:
1. Lock the technical approach
2. Create child issues for implementation
3. Assign to Backend Lead for execution
4. Verify AC1-AC7 pass before marking TEC-207 done
