import { describe, expect, it } from "vitest";
import { buildStatedDispositionBlockerIssueInput } from "../services/heartbeat.js";

describe("stated-disposition blocker issue inheritance", () => {
  it("keeps the source project, workspace, owner, and work mode", () => {
    const blocker = buildStatedDispositionBlockerIssueInput({
      sourceIdentifier: "TSMC-20696",
      sourceId: "source-issue-id",
      blocker: "EPUB portable-link normalization is required",
      projectId: "project-id",
      projectWorkspaceId: "workspace-id",
      executionWorkspaceSettings: { strategy: "project_primary" },
      workMode: "execute",
      assigneeAgentId: "agent-id",
      assigneeUserId: null,
    });

    expect(blocker).toMatchObject({
      projectId: "project-id",
      projectWorkspaceId: "workspace-id",
      executionWorkspaceSettings: { strategy: "project_primary" },
      workMode: "execute",
      assigneeAgentId: "agent-id",
      assigneeUserId: null,
    });
    expect(blocker.description).toContain("TSMC-20696");
  });
});
