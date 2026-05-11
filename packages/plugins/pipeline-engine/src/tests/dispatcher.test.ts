import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatcher.js";
import type { RoleMapping, StageDefinition } from "../types.js";

function createMockIssuesClient() {
  return {
    create: vi.fn().mockResolvedValue({ id: "new-issue-1" }),
    update: vi.fn().mockResolvedValue(undefined),
    requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
    createComment: vi.fn().mockResolvedValue(undefined),
    documents: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("dispatcher", () => {
  let issues: ReturnType<typeof createMockIssuesClient>;
  let dispatcher: Dispatcher;
  const roleMapping: RoleMapping = {
    "code-writer": "agent-uuid-1",
    "spec-reviewer": "agent-uuid-2",
  };

  beforeEach(() => {
    issues = createMockIssuesClient();
    dispatcher = new Dispatcher(issues as any, roleMapping, "paperclipai.pipeline-engine");
  });

  it("creates a sub-issue for a worker stage", async () => {
    const stage: StageDefinition = { id: "implement", type: "worker", agent_role: "code-writer" };
    const result = await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage,
      companyId: "company-1",
      parentIssueId: "parent-1",
    });
    expect(issues.create).toHaveBeenCalledOnce();
    const createCall = issues.create.mock.calls[0][0];
    expect(createCall.assigneeAgentId).toBe("agent-uuid-1");
    expect(createCall.parentId).toBe("parent-1");
    expect(result.issueId).toBe("new-issue-1");
  });

  it("throws CONFIGURATION_ERROR for unknown role", async () => {
    const stage: StageDefinition = { id: "unknown", type: "worker", agent_role: "nonexistent-role" };
    await expect(
      dispatcher.dispatch({ pipelineRunId: "run-1", stage, companyId: "company-1", parentIssueId: "parent-1" }),
    ).rejects.toThrow("CONFIGURATION_ERROR");
  });

  it("requests wakeup after creating issue", async () => {
    const stage: StageDefinition = { id: "review", type: "classifier", agent_role: "spec-reviewer" };
    await dispatcher.dispatch({ pipelineRunId: "run-1", stage, companyId: "company-1", parentIssueId: "parent-1" });
    expect(issues.requestWakeup).toHaveBeenCalledOnce();
  });

  it("includes failure context in retry dispatch", async () => {
    const stage: StageDefinition = { id: "implement", type: "worker", agent_role: "code-writer" };
    await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage,
      companyId: "company-1",
      parentIssueId: "parent-1",
      context: "Fix validation failures: test_a failed",
    });
    const createCall = issues.create.mock.calls[0][0];
    expect(createCall.description).toContain("Fix validation failures");
  });
});
