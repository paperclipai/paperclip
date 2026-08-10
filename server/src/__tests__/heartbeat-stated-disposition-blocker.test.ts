import { describe, expect, it } from "vitest";
import {
  buildStatedDispositionBlockerIssueInput,
  isTransientPaperclipControlPlaneWriteFailure,
} from "../services/heartbeat.js";

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

  it("recognizes a transient Paperclip write failure rather than treating it as task work", () => {
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Could not record issue state because Paperclip API is unreachable at http://127.0.0.1:3100 (connection refused).",
    )).toBe(true);
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Paperclip control-plane write could not be recorded: ECONNREFUSED",
    )).toBe(true);
    expect(isTransientPaperclipControlPlaneWriteFailure(
      "Waiting for the approved design source package from the media team.",
    )).toBe(false);
  });
});
