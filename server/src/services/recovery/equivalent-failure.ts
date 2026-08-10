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
]);

function isGenuineFailure(observation: FailureObservation) {
  return (
    (observation.status === "failed" || observation.status === "timed_out") &&
    !TRANSIENT_LOCK_CONTENTION_ERROR_CODES.has(observation.errorCode ?? "")
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
