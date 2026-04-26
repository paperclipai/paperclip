import { describe, expect, it } from "vitest";
import {
  collectAgentAdapterWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectExecutionWorkspaceCommandPaths,
} from "./workspace-command-authz.js";

// ============================================================================
// collectAgentAdapterWorkspaceCommandPaths
// ============================================================================

describe("collectAgentAdapterWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths("string")).toEqual([]);
  });

  it("returns empty array when no workspaceStrategy", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths({ model: "gpt-4" })).toEqual([]);
  });

  it("returns path when workspaceStrategy has provisionCommand", () => {
    const config = { workspaceStrategy: { provisionCommand: "setup.sh" } };
    const result = collectAgentAdapterWorkspaceCommandPaths(config);
    expect(result).toContain("adapterConfig.workspaceStrategy.provisionCommand");
  });

  it("returns path when workspaceStrategy has teardownCommand", () => {
    const config = { workspaceStrategy: { teardownCommand: "cleanup.sh" } };
    const result = collectAgentAdapterWorkspaceCommandPaths(config);
    expect(result).toContain("adapterConfig.workspaceStrategy.teardownCommand");
  });

  it("returns both paths when workspaceStrategy has both commands", () => {
    const config = {
      workspaceStrategy: { provisionCommand: "setup.sh", teardownCommand: "cleanup.sh" },
    };
    const result = collectAgentAdapterWorkspaceCommandPaths(config);
    expect(result).toHaveLength(2);
  });
});

// ============================================================================
// collectProjectExecutionWorkspaceCommandPaths
// ============================================================================

describe("collectProjectExecutionWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns path when policy has workspaceStrategy.provisionCommand", () => {
    const policy = { workspaceStrategy: { provisionCommand: "init.sh" } };
    const result = collectProjectExecutionWorkspaceCommandPaths(policy);
    expect(result).toContain("executionWorkspacePolicy.workspaceStrategy.provisionCommand");
  });

  it("returns empty when workspaceStrategy has no commands", () => {
    const policy = { workspaceStrategy: { type: "docker" } };
    expect(collectProjectExecutionWorkspaceCommandPaths(policy)).toEqual([]);
  });
});

// ============================================================================
// collectProjectWorkspaceCommandPaths
// ============================================================================

describe("collectProjectWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectProjectWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns 'cleanupCommand' when patch has that field", () => {
    const result = collectProjectWorkspaceCommandPaths({ cleanupCommand: "rm -rf ./build" });
    expect(result).toContain("cleanupCommand");
  });

  it("uses prefix when provided", () => {
    const result = collectProjectWorkspaceCommandPaths({ cleanupCommand: "cleanup.sh" }, "workspace");
    expect(result).toContain("workspace.cleanupCommand");
  });

  it("returns empty when cleanupCommand is not in patch", () => {
    expect(collectProjectWorkspaceCommandPaths({ name: "my-project" })).toEqual([]);
  });
});

// ============================================================================
// collectIssueWorkspaceCommandPaths
// ============================================================================

describe("collectIssueWorkspaceCommandPaths", () => {
  it("returns empty array for empty input", () => {
    expect(collectIssueWorkspaceCommandPaths({})).toEqual([]);
  });

  it("collects paths from executionWorkspaceSettings.workspaceStrategy", () => {
    const input = {
      executionWorkspaceSettings: {
        workspaceStrategy: { provisionCommand: "setup.sh" },
      },
    };
    const result = collectIssueWorkspaceCommandPaths(input);
    expect(result).toContain("executionWorkspaceSettings.workspaceStrategy.provisionCommand");
  });

  it("collects paths from assigneeAdapterOverrides.adapterConfig.workspaceStrategy", () => {
    const input = {
      assigneeAdapterOverrides: {
        adapterConfig: {
          workspaceStrategy: { teardownCommand: "cleanup.sh" },
        },
      },
    };
    const result = collectIssueWorkspaceCommandPaths(input);
    expect(result).toContain(
      "assigneeAdapterOverrides.adapterConfig.workspaceStrategy.teardownCommand",
    );
  });

  it("collects from both sources simultaneously", () => {
    const input = {
      executionWorkspaceSettings: {
        workspaceStrategy: { provisionCommand: "setup.sh" },
      },
      assigneeAdapterOverrides: {
        adapterConfig: {
          workspaceStrategy: { teardownCommand: "cleanup.sh" },
        },
      },
    };
    const result = collectIssueWorkspaceCommandPaths(input);
    expect(result).toHaveLength(2);
  });

  it("handles non-record executionWorkspaceSettings gracefully", () => {
    expect(
      collectIssueWorkspaceCommandPaths({ executionWorkspaceSettings: "not-an-object" }),
    ).toEqual([]);
  });
});

// ============================================================================
// collectExecutionWorkspaceCommandPaths
// ============================================================================

describe("collectExecutionWorkspaceCommandPaths", () => {
  it("returns empty array for empty input", () => {
    expect(collectExecutionWorkspaceCommandPaths({})).toEqual([]);
  });

  it("collects paths from config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { provisionCommand: "provision.sh" },
    });
    expect(result).toContain("config.provisionCommand");
  });

  it("collects cleanupCommand from config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { cleanupCommand: "cleanup.sh" },
    });
    expect(result).toContain("config.cleanupCommand");
  });

  it("collects paths from metadata.config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      metadata: { config: { teardownCommand: "teardown.sh" } },
    });
    expect(result).toContain("metadata.config.teardownCommand");
  });

  it("collects from both config and metadata", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { provisionCommand: "p.sh" },
      metadata: { config: { teardownCommand: "t.sh" } },
    });
    expect(result).toHaveLength(2);
  });
});
