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
]);

// Resource ceilings are scoping verdicts, not lane failures: the task did not fit the budget it
// was given. Feeding them to the breaker pauses a healthy lane and strands its whole queue
// (Coder-Hermes 08-16, Architect-Codex 08-17 — TSMC-20910 instances 3 and 4). The oversized
// card still fails loudly per-run; the lane stays available for the rest of its work.
const RESOURCE_CEILING_ERROR_CODES = new Set([
  "token_budget_exhausted",
  "max_turns_exhausted",
  "issue_generation_ceiling_exceeded",
]);

function isGenuineFailure(observation: FailureObservation) {
  return (
    (observation.status === "failed" || observation.status === "timed_out") &&
    !TRANSIENT_LOCK_CONTENTION_ERROR_CODES.has(observation.errorCode ?? "") &&
    !RESOURCE_CEILING_ERROR_CODES.has(observation.errorCode ?? "")
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
