import { describe, expect, it, vi } from "vitest";
import type { RealizedExecutionWorkspace, RuntimeServiceRef } from "../services/workspace-runtime.js";
import { postWorkspaceReadyComment } from "../services/heartbeat.js";

describe("heartbeat workspace-ready comment", () => {
  it("passes presentation and metadata in the addComment options argument", async () => {
    const workspace: RealizedExecutionWorkspace = {
      baseCwd: "/repo",
      source: "project_primary",
      projectId: "project-id",
      workspaceId: "project-workspace-id",
      repoUrl: null,
      repoRef: "main",
      strategy: "git_worktree",
      cwd: "/repo/.paperclip/worktrees/PAP-16051",
      branchName: "PAP-16051-workspace-ready-notice",
      worktreePath: "/repo/.paperclip/worktrees/PAP-16051",
      warnings: [],
      created: true,
    };
    const runtimeServices: RuntimeServiceRef[] = [];
    const addComment = vi.fn().mockResolvedValue({ id: "comment-id" });

    await postWorkspaceReadyComment({
      issuesSvc: { addComment },
      issueId: "issue-id",
      agentId: "agent-id",
      runId: "run-id",
      workspace,
      runtimeServices,
    });

    expect(addComment).toHaveBeenCalledOnce();
    expect(addComment).toHaveBeenCalledWith(
      "issue-id",
      [
        "## Workspace Ready",
        "",
        "- Strategy: `git_worktree`",
        "- Branch: `PAP-16051-workspace-ready-notice`",
        "- CWD: `/repo/.paperclip/worktrees/PAP-16051`",
      ].join("\n"),
      { agentId: "agent-id", runId: "run-id" },
      {
        presentation: {
          kind: "system_notice",
          tone: "info",
          title: "Workspace ready · PAP-16051-workspace-ready-notice",
          density: "compact",
          detailsDefaultOpen: false,
        },
        metadata: {
          version: 1,
          sections: [{
            title: "Workspace",
            rows: [
              { type: "key_value", label: "Strategy", value: "git_worktree" },
              { type: "key_value", label: "Branch", value: "PAP-16051-workspace-ready-notice" },
              { type: "key_value", label: "CWD", value: "/repo/.paperclip/worktrees/PAP-16051" },
            ],
          }],
        },
      },
    );
  });
});
