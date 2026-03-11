type StaleCheckoutState = {
  status: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
};

type StaleCheckoutAdoptionInput = {
  actorAgentId: string;
  actorRunId: string | null;
  current: StaleCheckoutState;
};

export function shouldAttemptStaleCheckoutAdoption(input: StaleCheckoutAdoptionInput): boolean {
  if (!input.actorRunId) return false;
  if (input.current.status !== "in_progress") return false;
  if (input.current.assigneeAgentId !== input.actorAgentId) return false;
  if (!input.current.checkoutRunId) return false;
  if (input.current.checkoutRunId === input.actorRunId) return false;

  // Fail closed when the execution lock does not align with the stale checkout lock.
  // This prevents cross-run lock adoption when run ownership is ambiguous.
  return (
    input.current.executionRunId == null ||
    input.current.executionRunId === input.current.checkoutRunId
  );
}
