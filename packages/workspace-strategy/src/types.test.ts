import { describe, it, expect, expectTypeOf } from "vitest";
import {
  type ExecutionWorkspaceStrategy,
  type ExecutionWorkspaceStrategyType,
  type WorkspaceRealizationRequest,
  type WorkspaceRealizationRecord,
  type WorkspaceRealizationTransport,
} from "./index.js";

describe("workspace-strategy package types", () => {
  it("ExecutionWorkspaceStrategyType is the existing four-variant union", () => {
    const t: ExecutionWorkspaceStrategyType = "git_worktree";
    expect(t).toBe("git_worktree");
    expectTypeOf<ExecutionWorkspaceStrategyType>().toEqualTypeOf<
      "project_primary" | "git_worktree" | "adapter_managed" | "cloud_sandbox"
    >();
  });

  it("ExecutionWorkspaceStrategy keeps the existing field shape", () => {
    const s: ExecutionWorkspaceStrategy = {
      type: "git_worktree",
      baseRef: "main",
      branchTemplate: "agent/{{issueId}}",
      worktreeParentDir: "/repos/_worktrees",
    };
    expect(s.type).toBe("git_worktree");
  });

  it("WorkspaceRealizationRequest has version=1 and source/runtimeOverlay groups", () => {
    const r: WorkspaceRealizationRequest = {
      version: 1,
      adapterType: "claude_local",
      companyId: "c_1",
      environmentId: "env_1",
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: "hb_1",
      requestedMode: null,
      source: {
        kind: "project_primary",
        localPath: "/workspace",
        projectId: null,
        projectWorkspaceId: null,
        repoUrl: "https://github.com/acme/repo.git",
        repoRef: "main",
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      runtimeOverlay: {
        provisionCommand: null,
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: null,
      },
    };
    expect(r.version).toBe(1);
  });

  it("transport union exposes the four canonical values", () => {
    const t: WorkspaceRealizationTransport = "ssh";
    expect(t).toBe("ssh");
    expectTypeOf<WorkspaceRealizationTransport>().toEqualTypeOf<
      "local" | "ssh" | "sandbox" | "plugin"
    >();
  });
});
