import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeOnCheckout } from "../routes/issues-checkout-wakeup.js";
import { shouldAdoptRunSourceIssue } from "../services/run-source-issue.js";

describe("shouldAdoptRunSourceIssue", () => {
  it("adopts for agent self-checkout in an active run", () => {
    expect(
      shouldAdoptRunSourceIssue({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-1",
        checkoutRunId: "run-1",
      }),
    ).toBe(true);
  });

  it("does not adopt for board actors", () => {
    expect(
      shouldAdoptRunSourceIssue({
        actorType: "board",
        actorAgentId: null,
        checkoutAgentId: "agent-1",
        checkoutRunId: null,
      }),
    ).toBe(false);
  });

  it("does not adopt when the checkout run id is missing", () => {
    expect(
      shouldAdoptRunSourceIssue({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-1",
        checkoutRunId: null,
      }),
    ).toBe(false);
  });

  it("does not adopt when an agent checks out on behalf of another agent", () => {
    expect(
      shouldAdoptRunSourceIssue({
        actorType: "agent",
        actorAgentId: "agent-1",
        checkoutAgentId: "agent-2",
        checkoutRunId: "run-1",
      }),
    ).toBe(false);
  });

  // The two predicates decide the same branch, so a checkout must land in
  // exactly one of them. If both were ever true a run would be scoped twice; if
  // both were false, self-checkout would go back to leaving the run unscoped —
  // which is the bug this pair exists to close.
  it("is the exact complement of shouldWakeAssigneeOnCheckout", () => {
    const cases = [
      { actorType: "board", actorAgentId: null, checkoutAgentId: "agent-1", checkoutRunId: null },
      { actorType: "board", actorAgentId: null, checkoutAgentId: "agent-1", checkoutRunId: "run-1" },
      { actorType: "none", actorAgentId: null, checkoutAgentId: "agent-1", checkoutRunId: "run-1" },
      { actorType: "agent", actorAgentId: null, checkoutAgentId: "agent-1", checkoutRunId: "run-1" },
      { actorType: "agent", actorAgentId: "agent-1", checkoutAgentId: "agent-1", checkoutRunId: "run-1" },
      { actorType: "agent", actorAgentId: "agent-1", checkoutAgentId: "agent-1", checkoutRunId: null },
      { actorType: "agent", actorAgentId: "agent-1", checkoutAgentId: "agent-2", checkoutRunId: "run-1" },
    ] as const;

    for (const input of cases) {
      expect(shouldAdoptRunSourceIssue(input)).toBe(!shouldWakeAssigneeOnCheckout(input));
    }
  });
});
