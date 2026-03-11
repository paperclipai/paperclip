import { describe, expect, it } from "vitest";
import { shouldAttemptStaleCheckoutAdoption } from "../services/issues-checkout-adoption.js";

describe("shouldAttemptStaleCheckoutAdoption", () => {
  it("allows adoption when stale checkout lock is present for same assignee", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-old",
        },
      }),
    ).toBe(true);
  });

  it("blocks adoption when execution lock points to a different run", () => {
    expect(
      shouldAttemptStaleCheckoutAdoption({
        actorAgentId: "agent-1",
        actorRunId: "run-new",
        current: {
          status: "in_progress",
          assigneeAgentId: "agent-1",
          checkoutRunId: "run-old",
          executionRunId: "run-foreign",
        },
      }),
    ).toBe(false);
  });
});
