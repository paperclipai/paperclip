import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeOnCheckout } from "../routes/issues-checkout-wakeup.js";

describe("shouldWakeAssigneeOnCheckout", () => {
  it("keeps wakeup behavior for board actors", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "board",
        actorAgentId: null,
        checkoutAgentId: "agent-1",
        checkoutRunId: null,
      }),
    ).toBe(true);
  });

  it("skips wakeup for agent self-checkout in an active run", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-1",
        checkoutRunId: "run-1",
      }),
    ).toBe(false);
  });

  it("still wakes when checkout run id is missing", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-1",
        checkoutRunId: null,
      }),
    ).toBe(true);
  });

  it("still wakes when agent checks out on behalf of another agent id", () => {
    expect(
      shouldWakeAssigneeOnCheckout({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-2",
        checkoutRunId: "run-1",
      }),
    ).toBe(true);
  });
});
