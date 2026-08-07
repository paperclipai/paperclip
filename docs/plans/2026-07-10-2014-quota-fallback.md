# Quota Fallback: reassign to a fallback agent on quota exhaustion (#2014)

Branch: `tginter/2014-quota-fallback`
Status: implemented, tests green (see Verification)

## Problem

When an adapter run fails with `errorFamily: provider_quota`, today the only
recovery is to park the same agent behind a `retryNotBefore` scheduled retry
until the provider quota resets. Work on the issue stalls for hours even when
another agent (on a different provider/adapter) is idle and able to continue.

## Design (decided)

On a failed run whose error family matches the agent's configured fallback
triggers, **reassign the issue to a configured fallback agent** instead of
scheduling the same-agent retry. The fallback agent has a different
`adapterType`, so the handoff gets a fresh session by construction (session
isolation without new machinery). No DB schema changes.

### Config shape (in `agent.adapterConfig`)

```json
"fallback": {
  "enabled": true,
  "agentId": "<uuid of fallback agent>",
  "on": ["provider_quota"],
  "when": "immediate"
}
```

- `on` — trigger families; defaults to `["provider_quota"]`; may also include
  `"max_turns"` (max-turn exhaustion runs).
- `when` — `"immediate"` (default: fall back on the first matching failure) or
  `"retries_exhausted"` (only once `scheduledRetryAttempt >= maxAttempts`,
  reusing the existing bounded-retry attempt accounting).
- All keys optional; block validated by
  `adapterFallbackConfigSchema` (`packages/shared/src/validators/agent.ts`) —
  strict inside the block, fully backward compatible outside it.

### Behavior

Decision point: the failed-run retry branch of the heartbeat finalize path
(`server/src/services/heartbeat.ts`, after `setRunStatusIfRunning`). For both
the max-turn-continuation branch and the transient-recovery branch, the new
`maybeFallbackReassign(run, agent)` is consulted first; the existing
`scheduleBoundedRetryForRun` call runs only when the fallback does **not**
reassign.

`maybeFallbackReassign`:

1. Parses `adapterConfig.fallback`; bails (`not_applicable`) when disabled,
   when the run's trigger (`provider_quota` / `max_turns`) is not in `on`, or
   when `when: "retries_exhausted"` and attempts remain.
2. Validates the fallback agent: configured, not the same agent, exists in the
   same company, and passes the same invokability gate used by
   `scheduleBoundedRetryForRun`. Also requires an issue in the run context,
   assigned to the failing agent and not in a terminal status. Any validation
   failure logs a warning + a `warn` run event and returns `not_applied`, so
   the caller falls through to the untouched existing retry/parking behavior.
3. On success:
   - updates `issues.assigneeAgentId` to the fallback agent and releases the
     execution lock (`executionRunId` / `executionAgentNameKey` /
     `executionLockedAt`);
   - writes activity log `issue.quota_fallback_reassigned` with
     `{fromAgentId, toAgentId, errorFamily, runId}`;
   - posts an issue comment documenting the handoff;
   - persists an auditable marker in the failed run's `resultJson`:
     `{"fallback": {"fromAgentId", "toAgentId", "trigger", "at"}}`;
   - wakes the fallback agent (`issue_assigned`, source `assignment`).
4. The original agent's same-adapter retry is suppressed only when the
   fallback actually reassigned; `retryNotBefore` parking is untouched when
   fallback is disabled or not matching.

Public surface: `heartbeat.maybeFallbackReassign(runId, opts?)` mirrors
`heartbeat.scheduleBoundedRetry` for tests and tooling.

## Files changed

- `packages/shared/src/validators/agent.ts` — `adapterFallbackTriggerSchema`,
  `adapterFallbackConfigSchema`, wired into `adapterConfigSchema.superRefine`.
- `packages/shared/src/agent-fallback-config.test.ts` — validator coverage.
- `server/src/services/heartbeat.ts` — `parseAdapterFallbackConfig`,
  `readAdapterFallbackTriggerFromRun`, `maybeFallbackReassign`, finalize-path
  wiring, public wrapper.
- `server/src/__tests__/heartbeat-quota-fallback.test.ts` — embedded-Postgres
  suite (8 tests).

## Verification

- `server`: `heartbeat-quota-fallback.test.ts` 8/8 pass;
  `heartbeat-retry-scheduling.test.ts` + `issue-scheduled-retry-routes.test.ts`
  33/33 pass (regression guard).
- `packages/shared`: `agent-fallback-config.test.ts` 10/10 pass.
- `tsc --noEmit` clean in `server` and `packages/shared`.

## Upstream PR description (ready to paste)

> ### Quota fallback: reassign the issue to a fallback agent instead of parking until quota reset
>
> Implements the retry-time fallback proposed in #2014.
>
> When an agent's run fails with a quota-family error (`provider_quota`, and
> optionally max-turn exhaustion), the heartbeat finalize path can now hand the
> issue to a configured fallback agent instead of scheduling the same-agent
> retry and waiting for the provider quota window to reset. Because the
> fallback agent runs a different adapter, the handoff starts from a fresh
> session by construction — no session-sharing or schema changes involved.
>
> **Opt-in config** (per agent, inside `adapterConfig`; validated, strict-keyed,
> fully backward compatible):
>
> ```json
> "fallback": {"enabled": true, "agentId": "<uuid>", "on": ["provider_quota"], "when": "immediate"}
> ```
>
> - `on` defaults to `["provider_quota"]`; `"max_turns"` is also supported.
> - `when: "immediate"` falls back on the first matching failure;
>   `"retries_exhausted"` keeps the existing bounded retries and only falls
>   back once attempts are exhausted.
>
> **Semantics**
> - On fallback: `issues.assigneeAgentId` is updated, the execution lock is
>   released, an `issue.quota_fallback_reassigned` activity entry and a handoff
>   issue comment are written, the failed run's `resultJson` gets an auditable
>   `fallback` marker, and the fallback agent is woken with `issue_assigned`.
>   The original agent's same-adapter retry is suppressed — the fallback agent
>   now owns the issue.
> - Fallback target is validated (same company, different agent, invokable).
>   Any misconfiguration logs a warning run event and falls through to the
>   existing retry/parking behavior unchanged; behavior with fallback disabled
>   or unset is byte-for-byte the status quo.
>
> **Tests**: new embedded-Postgres suite covering immediate fallback end to end
> (reassignment, activity log, comment, no same-agent retry), disabled-fallback
> regression, `retries_exhausted` gating, invalid/missing/same-agent/paused
> fallback targets, and non-matching error families; plus validator tests for
> the config block. Existing retry-scheduling suites pass unchanged.
