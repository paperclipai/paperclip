type CheckoutWakeInput = {
  actorType: "board" | "agent" | "none";
  actorAgentId: string | null;
  checkoutAgentId: string;
  checkoutRunId: string | null;
};

/** Returns true if the issue assignee should be woken when a checkout occurs (false if the agent checked out its own run). */
export function shouldWakeAssigneeOnCheckout(input: CheckoutWakeInput): boolean {
  if (input.actorType !== "agent") return true;
  if (!input.actorAgentId) return true;
  if (input.actorAgentId !== input.checkoutAgentId) return true;
  if (!input.checkoutRunId) return true;
  return false;
}
