/**
 * A governance pause stop: the control plane cancelled the run because its
 * agent was paused (the direct pause route, or the agent lifecycle stop that a
 * budget, company or manual pause issues) or because a budget hard stop fenced it. The stop is
 * intentional, not a failure: the task keeps its status, and resuming
 * continues the work (budget-resume-continuation.ts). It never becomes a
 * reconciliation incident that has no control.
 */
export const AGENT_LIFECYCLE_STOP_REASON = "Agent lifecycle stop requested";
export const BUDGET_PAUSE_STOP_REASON = "Cancelled due to budget pause";
/** The direct pause route stops the agent's runs with this reason before the lifecycle worker runs. */
export const AGENT_PAUSE_STOP_REASON = "Cancelled due to agent pause";

const GOVERNANCE_PAUSE_STOP_REASONS: ReadonlySet<string> = new Set([
  AGENT_LIFECYCLE_STOP_REASON, BUDGET_PAUSE_STOP_REASON, AGENT_PAUSE_STOP_REASON]);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function isGovernancePauseStop(run: { status: string; resultJson?: Record<string, unknown> | null }): boolean {
  if (run.status !== "cancelled") return false;
  const cancellation = record(run.resultJson?.cancellation);
  if (record(cancellation.initiator).type !== "system" || cancellation.expected !== true
    || typeof cancellation.reason !== "string" || !GOVERNANCE_PAUSE_STOP_REASONS.has(cancellation.reason)) return false;
  // Termination and cleanup issue the same lifecycle stop reason. Only the
  // pausing path records pauseStop, so require it for that reason.
  return cancellation.reason !== AGENT_LIFECYCLE_STOP_REASON
    || Object.keys(record(run.resultJson?.pauseStop)).length > 0;
}
