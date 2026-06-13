import { describe, expect, it } from "vitest";
import type { ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";
import {
  assertRunWorkspaceIsolation,
  policyMandatesWorktreeIsolation,
  shouldUseProjectWorkspaceForRun,
  WorkspaceIsolationError,
} from "../services/execution-workspace-policy.js";

// Fix 1 (B1 gap-fix): an agent run must never execute in the operator's shared
// project clone when the project policy mandates git_worktree isolation. These
// unit tests cover the three pure helpers that enforce it.

function policy(overrides: Partial<ProjectExecutionWorkspacePolicy> = {}): ProjectExecutionWorkspacePolicy {
  return {
    enabled: true,
    defaultMode: "isolated_workspace",
    workspaceStrategy: { type: "git_worktree" },
    ...overrides,
  } as ProjectExecutionWorkspacePolicy;
}

describe("policyMandatesWorktreeIsolation", () => {
  it("is true only when the policy strategy is git_worktree", () => {
    expect(policyMandatesWorktreeIsolation(policy())).toBe(true);
    expect(policyMandatesWorktreeIsolation(policy({ workspaceStrategy: { type: "project_primary" } }))).toBe(false);
    expect(policyMandatesWorktreeIsolation(policy({ workspaceStrategy: null }))).toBe(false);
    expect(policyMandatesWorktreeIsolation(null)).toBe(false);
  });
});

describe("shouldUseProjectWorkspaceForRun", () => {
  it("never uses the project clone for agent_default mode", () => {
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "agent_default", policyMandatesWorktree: false })).toBe(false);
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "agent_default", policyMandatesWorktree: true })).toBe(false);
  });

  it("allows the clone for isolated_workspace under a worktree policy (it becomes a worktree)", () => {
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "isolated_workspace", policyMandatesWorktree: true })).toBe(true);
  });

  it("routes non-isolated runs OFF the clone when the policy mandates worktrees", () => {
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "shared_workspace", policyMandatesWorktree: true })).toBe(false);
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "operator_branch", policyMandatesWorktree: true })).toBe(false);
  });

  it("leaves projects without a worktree policy unchanged (clone allowed for non-agent_default)", () => {
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "shared_workspace", policyMandatesWorktree: false })).toBe(true);
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "operator_branch", policyMandatesWorktree: false })).toBe(true);
    expect(shouldUseProjectWorkspaceForRun({ requestedMode: "isolated_workspace", policyMandatesWorktree: false })).toBe(true);
  });
});

describe("assertRunWorkspaceIsolation", () => {
  const scratchCwd = "/home/agent/.paperclip/scratch/agent-1";
  const cloneCwd = "/Users/op/sourceControl/paperclip";
  const worktreeCwd = "/Users/op/sourceControl/paperclip/.paperclip/worktrees/HIV-8-foo";

  it("throws when a worktree policy run lands in a shared clone", () => {
    expect(() =>
      assertRunWorkspaceIsolation({
        policyMandatesWorktree: true,
        realizedStrategy: "project_primary",
        realizedCwd: cloneCwd,
        scratchCwd,
      }),
    ).toThrow(WorkspaceIsolationError);
  });

  it("passes when the realized workspace is an actual git_worktree", () => {
    expect(() =>
      assertRunWorkspaceIsolation({
        policyMandatesWorktree: true,
        realizedStrategy: "git_worktree",
        realizedCwd: worktreeCwd,
        scratchCwd,
      }),
    ).not.toThrow();
  });

  it("passes when a non-isolated run was routed to the agent scratch dir", () => {
    expect(() =>
      assertRunWorkspaceIsolation({
        policyMandatesWorktree: true,
        realizedStrategy: "project_primary",
        realizedCwd: scratchCwd,
        scratchCwd,
      }),
    ).not.toThrow();
  });

  it("is a no-op for projects without a worktree-isolation policy", () => {
    expect(() =>
      assertRunWorkspaceIsolation({
        policyMandatesWorktree: false,
        realizedStrategy: "project_primary",
        realizedCwd: cloneCwd,
        scratchCwd,
      }),
    ).not.toThrow();
  });

  it("carries the offending cwd and a stable error code", () => {
    try {
      assertRunWorkspaceIsolation({
        policyMandatesWorktree: true,
        realizedStrategy: "project_primary",
        realizedCwd: cloneCwd,
        scratchCwd,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceIsolationError);
      expect((err as WorkspaceIsolationError).code).toBe("workspace_isolation_violation");
      expect((err as WorkspaceIsolationError).cwd).toBe(cloneCwd);
    }
  });
});
