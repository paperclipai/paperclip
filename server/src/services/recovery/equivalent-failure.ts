/**
 * The bounded detection half of the equivalent-failure circuit breaker.
 *
 * This deliberately has no persistence or recovery side effects. Action policy
 * is owned by the follow-up integration slice.
 */
export const EQUIVALENT_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type FailureObservation = {
  agentId: string | null;
  issueId: string | null;
  routineId: string | null;
  fingerprint: string | null;
  occurredAt: Date;
  status: "failed" | "timed_out" | "cancelled" | "interrupted";
  errorCode?: string | null;
};

export type EquivalentFailureMatch =
  | {
    kind: "agent_issue";
    agentId: string;
    issueId: string;
    failures: readonly [FailureObservation, FailureObservation];
  }
  | {
    kind: "routine_fingerprint";
    routineId: string;
    fingerprint: string;
    failures: readonly [FailureObservation, FailureObservation];
  };

const TRANSIENT_LOCK_CONTENTION_ERROR_CODES = new Set([
  "lock_contention",
  "transient_lock_contention",
  // The Antigravity adapter emits this only for a non-zero `agy` exit with no
  // stderr signature. It receives bounded backoff retries before any structural
  // circuit-breaker judgment (TSMC-20910).
  "antigravity_transient_silent_exit",
  // Same class, hermes: non-zero exit with no stderr diagnostic. Measured
  // 2026-08-18/19: 4/4 hermes adapter_failed runs were silent (codex 0/16);
  // the breaker paused healthy lanes on them, stranding grok-quota work.
  "hermes_transient_silent_exit",
]);

// Resource ceilings are scoping verdicts, not lane failures: the task did not fit the budget it
// was given. Feeding them to the breaker pauses a healthy lane and strands its whole queue
// (Coder-Hermes 08-16, Architect-Codex 08-17 — TSMC-20910 instances 3 and 4). The oversized
// card still fails loudly per-run; the lane stays available for the rest of its work.
export const RESOURCE_CEILING_ERROR_CODES = new Set([
  "token_budget_exhausted",
  "max_turns_exhausted",
  "issue_generation_ceiling_exceeded",
]);

/**
 * TSMC-21870: the exclusion above is right about the LANE and silent about the CARD.
 *
 * "The oversized card still fails loudly per-run" is true, and nothing bounded how many
 * times it was allowed to do so. Measured 2026-08-26 over 30h on claude-sonnet-5:
 *
 *   16 cards absorbed 55 turn-exhausted runs costing $156.08 — 50% of the entire
 *   claude bill — against 7 one-off capped runs costing $18.37.
 *   TSR-5837 x5 ($15.30), TSR-5863 x5 ($14.52), TSK-7605 x4 ($12.51), ...
 *
 * A resource-ceiling verdict is a statement about the CARD: it did not fit the budget.
 * Re-running it unchanged cannot succeed — the second attempt reads the same oversized
 * context and stops at the same wall. Each retry cost ~$2.81 and produced nothing, since
 * a run that exhausts its turns has by definition not finished its task.
 *
 * So: keep the lane out of the breaker (pausing a healthy lane over one oversized card is
 * the strand this exclusion exists to prevent), and bound the retries ON THE CARD instead.
 * The card needs re-scoping by a human or a split, not another attempt.
 */
export const REPEATED_RESOURCE_CEILING_THRESHOLD = 2;

export type RepeatedResourceCeilingMatch = {
  issueId: string;
  errorCode: string;
  occurrences: number;
};

/**
 * Same issue + same resource-ceiling code, at or over the threshold inside the window.
 * Scoped to the issue on purpose: the agent is not the thing at fault.
 */
export function classifyRepeatedResourceCeiling(
  observations: readonly FailureObservation[],
  now: Date,
  threshold: number = REPEATED_RESOURCE_CEILING_THRESHOLD,
): RepeatedResourceCeilingMatch | null {
  const counts = new Map<string, { issueId: string; errorCode: string; occurrences: number }>();
  for (const observation of observations) {
    if (!observation.issueId) continue;
    if (observation.status !== "failed" && observation.status !== "timed_out") continue;
    const errorCode = observation.errorCode ?? "";
    if (!RESOURCE_CEILING_ERROR_CODES.has(errorCode)) continue;
    if (!withinRollingWindow(observation, now)) continue;
    const key = `${observation.issueId}:${errorCode}`;
    const entry = counts.get(key) ?? { issueId: observation.issueId, errorCode, occurrences: 0 };
    entry.occurrences += 1;
    counts.set(key, entry);
  }
  let best: RepeatedResourceCeilingMatch | null = null;
  for (const entry of counts.values()) {
    if (entry.occurrences < threshold) continue;
    if (!best || entry.occurrences > best.occurrences) best = { ...entry };
  }
  return best;
}

// Provider quota exhaustion is a provider-side capacity verdict with its own
// first-class timed recovery path (provider_quota classification + scheduled
// quota-recovery monitor that retries after resetAt). Feeding it to the
// breaker double-punishes: the same quota storm that already deferred the lane
// would ALSO block its issues behind Unblock cards, exactly the healthy-lane
// strand the RESOURCE_CEILING exclusion above exists to prevent (TSMC-20853;
// same class as TSMC-20910 instances 3 and 4). Two quota-dead runs carry no
// more signal about the lane than one — the monitor owns the follow-up.
const PROVIDER_QUOTA_ERROR_CODES = new Set([
  "provider_quota",
  "gemini_quota_exhausted",
  "gemini_hello_probe_quota_exhausted",
  "antigravity_quota_exhausted",
]);

function isGenuineFailure(observation: FailureObservation) {
  return (
    (observation.status === "failed" || observation.status === "timed_out") &&
    !TRANSIENT_LOCK_CONTENTION_ERROR_CODES.has(observation.errorCode ?? "") &&
    !RESOURCE_CEILING_ERROR_CODES.has(observation.errorCode ?? "") &&
    !PROVIDER_QUOTA_ERROR_CODES.has(observation.errorCode ?? "")
  );
}

function withinRollingWindow(observation: FailureObservation, now: Date) {
  const occurredAt = observation.occurredAt.getTime();
  return occurredAt <= now.getTime() && occurredAt >= now.getTime() - EQUIVALENT_FAILURE_WINDOW_MS;
}

/**
 * Finds the first pair of equivalent genuine failures in the last 24 hours.
 * Equivalent means the same agent + issue, or the same routine + fingerprint.
 */
export function classifyEquivalentFailure(
  observations: readonly FailureObservation[],
  now = new Date(),
): EquivalentFailureMatch | null {
  const recentGenuineFailures = observations.filter(
    (observation) => isGenuineFailure(observation) && withinRollingWindow(observation, now),
  );

  for (let index = 0; index < recentGenuineFailures.length; index += 1) {
    const first = recentGenuineFailures[index]!;
    for (const second of recentGenuineFailures.slice(index + 1)) {
      if (first.agentId && first.issueId && first.agentId === second.agentId && first.issueId === second.issueId) {
        return { kind: "agent_issue", agentId: first.agentId, issueId: first.issueId, failures: [first, second] };
      }
      if (
        first.routineId &&
        first.fingerprint &&
        first.routineId === second.routineId &&
        first.fingerprint === second.fingerprint
      ) {
        return {
          kind: "routine_fingerprint",
          routineId: first.routineId,
          fingerprint: first.fingerprint,
          failures: [first, second],
        };
      }
    }
  }
  return null;
}
