import type { DecisionServiceOptions } from "./decisions.js";

type HeartbeatWakeup = (
  agentId: string,
  options: {
    source: "automation";
    triggerDetail: "system";
    reason: string;
    payload: Record<string, unknown>;
  },
) => Promise<unknown>;

/**
 * Connect decision continuations to the heartbeat runtime only while that
 * runtime is enabled. A disabled scheduler must not accept wakeups that it
 * cannot own for the rest of the process lifetime.
 */
export function createDecisionWakeOriginAgent(
  wakeup: HeartbeatWakeup | null,
): DecisionServiceOptions["wakeOriginAgent"] {
  if (!wakeup) return async () => null;
  return async (input) => wakeup(input.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: `decision_${input.outcome}`,
    payload: {
      issueId: input.issueId,
      decisionId: input.decisionId,
      outcome: input.outcome,
    },
  });
}
