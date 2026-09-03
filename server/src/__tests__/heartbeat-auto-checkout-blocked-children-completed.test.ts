import { describe, expect, it } from "vitest";
import { shouldAutoCheckoutIssueForWake } from "../services/heartbeat.js";

function baseInput() {
  return {
    contextSnapshot: { wakeReason: "issue_children_completed" } as Record<string, unknown>,
    issueStatus: "blocked",
    issueAssigneeAgentId: "agent-1",
    isDependencyReady: true,
    agentId: "agent-1",
  };
}

describe("shouldAutoCheckoutIssueForWake", () => {
  it("does not auto-checkout a blocked parent on an issue_children_completed wake", () => {
    expect(shouldAutoCheckoutIssueForWake(baseInput())).toBe(false);
  });

  it("still auto-checkouts a blocked issue when its own dependency was resolved", () => {
    expect(
      shouldAutoCheckoutIssueForWake({
        ...baseInput(),
        contextSnapshot: { wakeReason: "issue_blockers_resolved" },
      }),
    ).toBe(true);
  });

  it("still auto-checkouts a blocked issue when its own dependency was restored", () => {
    expect(
      shouldAutoCheckoutIssueForWake({
        ...baseInput(),
        contextSnapshot: { wakeReason: "issue_blockers_restored" },
      }),
    ).toBe(true);
  });

  it("still auto-checkouts a todo issue on an issue_children_completed wake", () => {
    expect(
      shouldAutoCheckoutIssueForWake({
        ...baseInput(),
        issueStatus: "todo",
      }),
    ).toBe(true);
  });

  it("still auto-checkouts an in_progress issue on an issue_children_completed wake", () => {
    expect(
      shouldAutoCheckoutIssueForWake({
        ...baseInput(),
        issueStatus: "in_progress",
      }),
    ).toBe(true);
  });
});
