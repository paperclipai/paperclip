import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./agent.js";

describe("adapterConfigSchema", () => {
  it("accepts a config with cwd and no workspaceStrategy", () => {
    const result = createAgentSchema.safeParse({
      name: "test-agent",
      adapterType: "claude_local",
      adapterConfig: { cwd: "/home/user/project" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a config with git_worktree strategy and no cwd", () => {
    const result = createAgentSchema.safeParse({
      name: "test-agent",
      adapterType: "claude_local",
      adapterConfig: { workspaceStrategy: { type: "git_worktree" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a config with project_primary strategy and cwd", () => {
    const result = createAgentSchema.safeParse({
      name: "test-agent",
      adapterType: "claude_local",
      adapterConfig: {
        cwd: "/home/user/project",
        workspaceStrategy: { type: "project_primary" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a config combining static cwd with git_worktree strategy", () => {
    const result = createAgentSchema.safeParse({
      name: "test-agent",
      adapterType: "claude_local",
      adapterConfig: {
        cwd: "/home/user/project",
        workspaceStrategy: { type: "git_worktree" },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const cwdError = result.error.issues.find(
        (issue) => issue.path.join(".") === "adapterConfig.cwd",
      );
      expect(cwdError).toBeDefined();
      expect(cwdError?.message).toContain("git_worktree");
    }
  });

  it("rejects a config with git_worktree strategy and a whitespace-only cwd as valid (empty string is not a cwd)", () => {
    const result = createAgentSchema.safeParse({
      name: "test-agent",
      adapterType: "claude_local",
      adapterConfig: {
        cwd: "   ",
        workspaceStrategy: { type: "git_worktree" },
      },
    });
    expect(result.success).toBe(true);
  });
});
