import { describe, expect, it } from "vitest";
import {
  CODE_MUTATING_AGENT_ROLES,
  decideWorkspaceStrategy,
} from "../services/workspace-resolver.ts";

describe("decideWorkspaceStrategy", () => {
  it("forces git_worktree for engineer role even when the request was project_primary (T1)", () => {
    const decision = decideWorkspaceStrategy({
      agentRole: "engineer",
      currentStrategyType: "project_primary",
    });
    expect(decision.strategyType).toBe("git_worktree");
    expect(decision.changed).toBe(true);
  });

  it("keeps git_worktree for engineer role without flagging changed=true", () => {
    const decision = decideWorkspaceStrategy({
      agentRole: "engineer",
      currentStrategyType: "git_worktree",
    });
    expect(decision.strategyType).toBe("git_worktree");
    expect(decision.changed).toBe(false);
  });

  it("includes devops in the code-mutating role set", () => {
    const decision = decideWorkspaceStrategy({
      agentRole: "devops",
      currentStrategyType: "project_primary",
    });
    expect(decision.strategyType).toBe("git_worktree");
    expect(decision.changed).toBe(true);
  });

  it("returns project_primary for cmo (non-code-mutating role) (T3)", () => {
    const decision = decideWorkspaceStrategy({
      agentRole: "cmo",
      currentStrategyType: "project_primary",
    });
    expect(decision.strategyType).toBe("project_primary");
    expect(decision.changed).toBe(false);
  });

  it("respects a non-mutating role's explicit git_worktree request (no override)", () => {
    // Non-code-mutating roles inherit the requested strategy; we only
    // *force* worktrees, never *block* a deliberate choice.
    const decision = decideWorkspaceStrategy({
      agentRole: "qa",
      currentStrategyType: "git_worktree",
    });
    expect(decision.strategyType).toBe("git_worktree");
    expect(decision.changed).toBe(false);
  });

  it("treats null/empty role like non-code-mutating", () => {
    const fromNull = decideWorkspaceStrategy({
      agentRole: null,
      currentStrategyType: "project_primary",
    });
    expect(fromNull.strategyType).toBe("project_primary");
    const fromBlank = decideWorkspaceStrategy({
      agentRole: "   ",
      currentStrategyType: "project_primary",
    });
    expect(fromBlank.strategyType).toBe("project_primary");
  });

  it("defaults the strategy to project_primary when none is set", () => {
    const decision = decideWorkspaceStrategy({
      agentRole: "cmo",
      currentStrategyType: "",
    });
    expect(decision.strategyType).toBe("project_primary");
  });

  it("publishes the code-mutating role set as a public constant", () => {
    expect(CODE_MUTATING_AGENT_ROLES.has("engineer")).toBe(true);
    expect(CODE_MUTATING_AGENT_ROLES.has("devops")).toBe(true);
    expect(CODE_MUTATING_AGENT_ROLES.has("cmo")).toBe(false);
  });
});
