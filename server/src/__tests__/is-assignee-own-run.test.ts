import { describe, expect, it } from "vitest";
import { isAssigneeOwnRun } from "../routes/is-assignee-own-run.js";

const issue = {
  assigneeAgentId: "agent-A",
  checkoutRunId: "run-1",
  executionRunId: "run-2",
};

describe("isAssigneeOwnRun", () => {
  it("returns false when issue has no assignee", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-A", runId: "run-1" },
        issue: { assigneeAgentId: null, checkoutRunId: "run-1", executionRunId: null },
      }),
    ).toBe(false);
  });

  it("returns false for non-agent actors", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "board", actorId: "agent-A", runId: "run-1" },
        issue,
      }),
    ).toBe(false);
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "user", actorId: "agent-A", runId: "run-1" },
        issue,
      }),
    ).toBe(false);
  });

  it("returns true when actor agent id matches assignee", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-A", runId: null },
        issue,
      }),
    ).toBe(true);
  });

  it("returns true for proxy/sub-agent whose runId matches checkoutRunId", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-Proxy", runId: "run-1" },
        issue,
      }),
    ).toBe(true);
  });

  it("returns true for proxy/sub-agent whose runId matches executionRunId", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-Proxy", runId: "run-2" },
        issue,
      }),
    ).toBe(true);
  });

  it("returns false for a different agent with an unrelated runId", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-B", runId: "run-other" },
        issue,
      }),
    ).toBe(false);
  });

  it("returns false for a different agent with no runId", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-B", runId: null },
        issue,
      }),
    ).toBe(false);
  });

  it("returns false when both run ids on the issue are null and ids differ", () => {
    expect(
      isAssigneeOwnRun({
        actor: { actorType: "agent", actorId: "agent-B", runId: "run-1" },
        issue: { assigneeAgentId: "agent-A", checkoutRunId: null, executionRunId: null },
      }),
    ).toBe(false);
  });
});
