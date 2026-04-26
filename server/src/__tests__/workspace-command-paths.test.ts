import { describe, it, expect } from "vitest";
import {
  collectAgentAdapterWorkspaceCommandPaths,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
  collectIssueWorkspaceCommandPaths,
  collectExecutionWorkspaceCommandPaths,
} from "../routes/workspace-command-authz.js";

// ---------------------------------------------------------------------------
// collectAgentAdapterWorkspaceCommandPaths
// ---------------------------------------------------------------------------

describe("collectAgentAdapterWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns empty array for non-object", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths("string")).toEqual([]);
    expect(collectAgentAdapterWorkspaceCommandPaths(42)).toEqual([]);
  });

  it("returns empty array when workspaceStrategy is absent", () => {
    expect(collectAgentAdapterWorkspaceCommandPaths({})).toEqual([]);
  });

  it("returns empty array when workspaceStrategy has no command keys", () => {
    expect(
      collectAgentAdapterWorkspaceCommandPaths({ workspaceStrategy: { mode: "shared" } }),
    ).toEqual([]);
  });

  it("collects provisionCommand path when present", () => {
    const result = collectAgentAdapterWorkspaceCommandPaths({
      workspaceStrategy: { provisionCommand: "echo provision" },
    });
    expect(result).toContain("adapterConfig.workspaceStrategy.provisionCommand");
  });

  it("collects teardownCommand path when present", () => {
    const result = collectAgentAdapterWorkspaceCommandPaths({
      workspaceStrategy: { teardownCommand: "echo teardown" },
    });
    expect(result).toContain("adapterConfig.workspaceStrategy.teardownCommand");
  });

  it("collects both provisionCommand and teardownCommand when both present", () => {
    const result = collectAgentAdapterWorkspaceCommandPaths({
      workspaceStrategy: { provisionCommand: "up", teardownCommand: "down" },
    });
    expect(result).toHaveLength(2);
    expect(result).toContain("adapterConfig.workspaceStrategy.provisionCommand");
    expect(result).toContain("adapterConfig.workspaceStrategy.teardownCommand");
  });
});

// ---------------------------------------------------------------------------
// collectProjectExecutionWorkspaceCommandPaths
// ---------------------------------------------------------------------------

describe("collectProjectExecutionWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns empty array when workspaceStrategy is absent", () => {
    expect(collectProjectExecutionWorkspaceCommandPaths({})).toEqual([]);
  });

  it("collects provisionCommand with correct prefix", () => {
    const result = collectProjectExecutionWorkspaceCommandPaths({
      workspaceStrategy: { provisionCommand: "echo provision" },
    });
    expect(result).toContain("executionWorkspacePolicy.workspaceStrategy.provisionCommand");
  });

  it("collects teardownCommand with correct prefix", () => {
    const result = collectProjectExecutionWorkspaceCommandPaths({
      workspaceStrategy: { teardownCommand: "echo teardown" },
    });
    expect(result).toContain("executionWorkspacePolicy.workspaceStrategy.teardownCommand");
  });
});

// ---------------------------------------------------------------------------
// collectProjectWorkspaceCommandPaths
// ---------------------------------------------------------------------------

describe("collectProjectWorkspaceCommandPaths", () => {
  it("returns empty array for null", () => {
    expect(collectProjectWorkspaceCommandPaths(null)).toEqual([]);
  });

  it("returns empty array when cleanupCommand is absent", () => {
    expect(collectProjectWorkspaceCommandPaths({})).toEqual([]);
    expect(collectProjectWorkspaceCommandPaths({ name: "my-workspace" })).toEqual([]);
  });

  it("collects cleanupCommand path when present", () => {
    const result = collectProjectWorkspaceCommandPaths({ cleanupCommand: "rm -rf tmp" });
    expect(result).toContain("cleanupCommand");
  });

  it("includes prefix when provided", () => {
    const result = collectProjectWorkspaceCommandPaths(
      { cleanupCommand: "rm -rf tmp" },
      "workspaces.0",
    );
    expect(result).toContain("workspaces.0.cleanupCommand");
  });

  it("uses empty prefix by default (no leading dot)", () => {
    const result = collectProjectWorkspaceCommandPaths({ cleanupCommand: "cmd" });
    expect(result[0]).toBe("cleanupCommand");
    expect(result[0]).not.toMatch(/^\./);
  });
});

// ---------------------------------------------------------------------------
// collectIssueWorkspaceCommandPaths
// ---------------------------------------------------------------------------

describe("collectIssueWorkspaceCommandPaths", () => {
  it("returns empty array when both inputs are absent", () => {
    expect(collectIssueWorkspaceCommandPaths({})).toEqual([]);
  });

  it("returns empty array when executionWorkspaceSettings has no workspaceStrategy", () => {
    expect(
      collectIssueWorkspaceCommandPaths({ executionWorkspaceSettings: { mode: "shared" } }),
    ).toEqual([]);
  });

  it("collects from executionWorkspaceSettings.workspaceStrategy", () => {
    const result = collectIssueWorkspaceCommandPaths({
      executionWorkspaceSettings: {
        workspaceStrategy: { provisionCommand: "echo up" },
      },
    });
    expect(result).toContain("executionWorkspaceSettings.workspaceStrategy.provisionCommand");
  });

  it("collects from assigneeAdapterOverrides.adapterConfig.workspaceStrategy", () => {
    const result = collectIssueWorkspaceCommandPaths({
      assigneeAdapterOverrides: {
        adapterConfig: {
          workspaceStrategy: { teardownCommand: "echo down" },
        },
      },
    });
    expect(result).toContain("assigneeAdapterOverrides.adapterConfig.workspaceStrategy.teardownCommand");
  });

  it("collects from both sources when both are present", () => {
    const result = collectIssueWorkspaceCommandPaths({
      executionWorkspaceSettings: {
        workspaceStrategy: { provisionCommand: "echo up" },
      },
      assigneeAdapterOverrides: {
        adapterConfig: {
          workspaceStrategy: { teardownCommand: "echo down" },
        },
      },
    });
    expect(result).toHaveLength(2);
  });

  it("ignores non-object assigneeAdapterOverrides", () => {
    expect(
      collectIssueWorkspaceCommandPaths({ assigneeAdapterOverrides: "invalid" }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectExecutionWorkspaceCommandPaths
// ---------------------------------------------------------------------------

describe("collectExecutionWorkspaceCommandPaths", () => {
  it("returns empty array for empty input", () => {
    expect(collectExecutionWorkspaceCommandPaths({})).toEqual([]);
  });

  it("collects provisionCommand from config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { provisionCommand: "echo up" },
    });
    expect(result).toContain("config.provisionCommand");
  });

  it("collects teardownCommand from config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { teardownCommand: "echo down" },
    });
    expect(result).toContain("config.teardownCommand");
  });

  it("collects cleanupCommand from config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { cleanupCommand: "echo clean" },
    });
    expect(result).toContain("config.cleanupCommand");
  });

  it("collects from metadata.config when present", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      metadata: {
        config: { provisionCommand: "provision" },
      },
    });
    expect(result).toContain("metadata.config.provisionCommand");
  });

  it("ignores metadata when metadata.config is absent", () => {
    expect(
      collectExecutionWorkspaceCommandPaths({
        metadata: { otherKey: "value" },
      }),
    ).toEqual([]);
  });

  it("collects from both config and metadata.config", () => {
    const result = collectExecutionWorkspaceCommandPaths({
      config: { provisionCommand: "up" },
      metadata: { config: { teardownCommand: "down" } },
    });
    expect(result).toHaveLength(2);
    expect(result).toContain("config.provisionCommand");
    expect(result).toContain("metadata.config.teardownCommand");
  });

  it("ignores non-object config", () => {
    expect(collectExecutionWorkspaceCommandPaths({ config: "not-an-object" })).toEqual([]);
    expect(collectExecutionWorkspaceCommandPaths({ config: null })).toEqual([]);
  });
});
