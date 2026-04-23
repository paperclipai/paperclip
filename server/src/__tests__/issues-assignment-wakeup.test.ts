import { describe, expect, it } from "vitest";
import { shouldWakeAssigneeOnAssignment } from "../routes/issues-assignment-wakeup.js";

describe("shouldWakeAssigneeOnAssignment", () => {
  it("keeps assignment wakeups for board actors", () => {
    expect(
      shouldWakeAssigneeOnAssignment({
        actorType: "board",
        actorAgentId: null,
        actorRunId: null,
        assignmentAgentId: "agent-1",
      }),
    ).toBe(true);
  });

  it("skips self-assignment wakeups from an active agent run", () => {
    expect(
      shouldWakeAssigneeOnAssignment({
        actorType: "agent",
        actorAgentId: "agent-1",
        actorRunId: "run-1",
        assignmentAgentId: "agent-1",
      }),
    ).toBe(false);
  });

  it("still wakes when the actor run id is missing", () => {
    expect(
      shouldWakeAssigneeOnAssignment({
        actorType: "agent",
        actorAgentId: "agent-1",
        actorRunId: null,
        assignmentAgentId: "agent-1",
      }),
    ).toBe(true);
  });

  it("still wakes when assigning a different agent", () => {
    expect(
      shouldWakeAssigneeOnAssignment({
        actorType: "agent",
        actorAgentId: "agent-1",
        actorRunId: "run-1",
        assignmentAgentId: "agent-2",
      }),
    ).toBe(true);
  });
});
