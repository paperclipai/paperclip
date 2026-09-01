import { describe, expect, it } from "vitest";
import {
  defaultExecutionWorktreeModeForProject,
  defaultProjectWorktreeIdForProject,
  issueExecutionWorktreeModeForExistingWorktree,
} from "./project-worktree-defaults";

describe("project workspace defaults", () => {
  it("prefers the execution policy default workspace over the primary workspace", () => {
    expect(defaultProjectWorktreeIdForProject({
      executionWorkspacePolicy: { defaultProjectWorkspaceId: "workspace-policy" },
      workspaces: [
        { id: "workspace-primary", isPrimary: true },
        { id: "workspace-secondary", isPrimary: false },
      ],
    })).toBe("workspace-policy");
  });

  it("falls back to the primary workspace, then the first workspace", () => {
    expect(defaultProjectWorktreeIdForProject({
      executionWorkspacePolicy: null,
      workspaces: [
        { id: "workspace-one", isPrimary: false },
        { id: "workspace-two", isPrimary: true },
      ],
    })).toBe("workspace-two");

    expect(defaultProjectWorktreeIdForProject({
      executionWorkspacePolicy: null,
      workspaces: [{ id: "workspace-one", isPrimary: false }],
    })).toBe("workspace-one");
  });

  it("maps project and reusable execution workspace modes to issue settings modes", () => {
    expect(defaultExecutionWorktreeModeForProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "adapter_default" },
    })).toBe("agent_default");

    expect(issueExecutionWorktreeModeForExistingWorktree("cloud_sandbox")).toBe("agent_default");
    expect(issueExecutionWorktreeModeForExistingWorktree("isolated_workspace")).toBe("isolated_workspace");
  });
});
