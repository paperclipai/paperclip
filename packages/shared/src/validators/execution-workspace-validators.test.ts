import { describe, it, expect } from "vitest";
import {
  executionWorkspaceStatusSchema,
  executionWorkspaceConfigSchema,
  executionWorkspaceCloseReadinessStateSchema,
  executionWorkspaceCloseActionKindSchema,
  executionWorkspaceCloseActionSchema,
  updateExecutionWorkspaceSchema,
} from "./execution-workspace.js";
import {
  agentSkillStateSchema,
  agentSkillOriginSchema,
  agentSkillSyncModeSchema,
  agentSkillEntrySchema,
  agentSkillSnapshotSchema,
  agentSkillSyncSchema,
} from "./adapter-skills.js";

// ============================================================================
// execution-workspace.ts
// ============================================================================

describe("executionWorkspaceStatusSchema", () => {
  it("accepts 'active'", () => {
    expect(executionWorkspaceStatusSchema.parse("active")).toBe("active");
  });

  it("accepts 'archived'", () => {
    expect(executionWorkspaceStatusSchema.parse("archived")).toBe("archived");
  });

  it("rejects unknown status", () => {
    expect(() => executionWorkspaceStatusSchema.parse("deleted")).toThrow();
  });
});

describe("executionWorkspaceConfigSchema", () => {
  it("parses an empty config", () => {
    const result = executionWorkspaceConfigSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts provisionCommand", () => {
    const result = executionWorkspaceConfigSchema.parse({ provisionCommand: "npm install" });
    expect(result.provisionCommand).toBe("npm install");
  });

  it("accepts desiredState 'running' or 'stopped'", () => {
    const r1 = executionWorkspaceConfigSchema.parse({ desiredState: "running" });
    const r2 = executionWorkspaceConfigSchema.parse({ desiredState: "stopped" });
    expect(r1.desiredState).toBe("running");
    expect(r2.desiredState).toBe("stopped");
  });

  it("rejects unknown desiredState", () => {
    expect(() => executionWorkspaceConfigSchema.parse({ desiredState: "paused" })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      executionWorkspaceConfigSchema.parse({ unknownField: "x" })
    ).toThrow();
  });
});

describe("executionWorkspaceCloseReadinessStateSchema", () => {
  it("accepts all valid states", () => {
    expect(executionWorkspaceCloseReadinessStateSchema.parse("ready")).toBe("ready");
    expect(executionWorkspaceCloseReadinessStateSchema.parse("ready_with_warnings")).toBe("ready_with_warnings");
    expect(executionWorkspaceCloseReadinessStateSchema.parse("blocked")).toBe("blocked");
  });

  it("rejects unknown state", () => {
    expect(() =>
      executionWorkspaceCloseReadinessStateSchema.parse("pending")
    ).toThrow();
  });
});

describe("executionWorkspaceCloseActionKindSchema", () => {
  it("accepts 'archive_record'", () => {
    expect(executionWorkspaceCloseActionKindSchema.parse("archive_record")).toBe("archive_record");
  });

  it("accepts 'git_worktree_remove'", () => {
    expect(executionWorkspaceCloseActionKindSchema.parse("git_worktree_remove")).toBe("git_worktree_remove");
  });

  it("rejects unknown kind", () => {
    expect(() => executionWorkspaceCloseActionKindSchema.parse("delete_bucket")).toThrow();
  });
});

describe("executionWorkspaceCloseActionSchema", () => {
  it("parses a valid close action", () => {
    const result = executionWorkspaceCloseActionSchema.parse({
      kind: "archive_record",
      label: "Archive",
      description: "Archive the workspace record",
      command: null,
    });
    expect(result.kind).toBe("archive_record");
    expect(result.command).toBeNull();
  });

  it("accepts a command string", () => {
    const result = executionWorkspaceCloseActionSchema.parse({
      kind: "cleanup_command",
      label: "Cleanup",
      description: "Run cleanup",
      command: "npm run cleanup",
    });
    expect(result.command).toBe("npm run cleanup");
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      executionWorkspaceCloseActionSchema.parse({
        kind: "archive_record",
        label: "A",
        description: "D",
        command: null,
        extra: "field",
      })
    ).toThrow();
  });
});

describe("updateExecutionWorkspaceSchema", () => {
  it("parses an empty update (all optional)", () => {
    const result = updateExecutionWorkspaceSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateExecutionWorkspaceSchema.parse({ name: "new-name" });
    expect(result.name).toBe("new-name");
  });

  it("accepts status update", () => {
    const result = updateExecutionWorkspaceSchema.parse({ status: "idle" });
    expect(result.status).toBe("idle");
  });

  it("accepts a config object", () => {
    const result = updateExecutionWorkspaceSchema.parse({
      config: { desiredState: "stopped" },
    });
    expect(result.config?.desiredState).toBe("stopped");
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      updateExecutionWorkspaceSchema.parse({ unknownField: "x" })
    ).toThrow();
  });
});

// ============================================================================
// adapter-skills.ts
// ============================================================================

describe("agentSkillStateSchema", () => {
  it("accepts all valid states", () => {
    const states = ["available", "configured", "installed", "missing", "stale", "external"];
    for (const state of states) {
      expect(agentSkillStateSchema.parse(state)).toBe(state);
    }
  });

  it("rejects unknown state", () => {
    expect(() => agentSkillStateSchema.parse("disabled")).toThrow();
  });
});

describe("agentSkillOriginSchema", () => {
  it("accepts all valid origins", () => {
    const origins = ["company_managed", "paperclip_required", "user_installed", "external_unknown"];
    for (const origin of origins) {
      expect(agentSkillOriginSchema.parse(origin)).toBe(origin);
    }
  });

  it("rejects unknown origin", () => {
    expect(() => agentSkillOriginSchema.parse("vendor_installed")).toThrow();
  });
});

describe("agentSkillSyncModeSchema", () => {
  it("accepts all valid modes", () => {
    const modes = ["unsupported", "persistent", "ephemeral"];
    for (const mode of modes) {
      expect(agentSkillSyncModeSchema.parse(mode)).toBe(mode);
    }
  });

  it("rejects unknown mode", () => {
    expect(() => agentSkillSyncModeSchema.parse("volatile")).toThrow();
  });
});

describe("agentSkillEntrySchema", () => {
  const validEntry = {
    key: "claude-code",
    runtimeName: "claude",
    desired: true,
    managed: true,
    state: "installed",
  };

  it("parses a minimal skill entry", () => {
    const result = agentSkillEntrySchema.parse(validEntry);
    expect(result.key).toBe("claude-code");
    expect(result.state).toBe("installed");
  });

  it("accepts null runtimeName", () => {
    const result = agentSkillEntrySchema.parse({ ...validEntry, runtimeName: null });
    expect(result.runtimeName).toBeNull();
  });

  it("rejects empty key", () => {
    expect(() => agentSkillEntrySchema.parse({ ...validEntry, key: "" })).toThrow();
  });

  it("accepts optional origin", () => {
    const result = agentSkillEntrySchema.parse({
      ...validEntry,
      origin: "company_managed",
    });
    expect(result.origin).toBe("company_managed");
  });
});

describe("agentSkillSnapshotSchema", () => {
  it("parses a valid snapshot", () => {
    const result = agentSkillSnapshotSchema.parse({
      adapterType: "claude_local",
      supported: true,
      mode: "persistent",
      desiredSkills: ["skill-a"],
      entries: [],
      warnings: [],
    });
    expect(result.adapterType).toBe("claude_local");
    expect(result.supported).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("rejects empty adapterType", () => {
    expect(() =>
      agentSkillSnapshotSchema.parse({
        adapterType: "",
        supported: true,
        mode: "persistent",
        desiredSkills: [],
        entries: [],
        warnings: [],
      })
    ).toThrow();
  });

  it("rejects invalid sync mode", () => {
    expect(() =>
      agentSkillSnapshotSchema.parse({
        adapterType: "claude_local",
        supported: true,
        mode: "manual",
        desiredSkills: [],
        entries: [],
        warnings: [],
      })
    ).toThrow();
  });
});

describe("agentSkillSyncSchema", () => {
  it("parses a sync request", () => {
    const result = agentSkillSyncSchema.parse({ desiredSkills: ["skill-a", "skill-b"] });
    expect(result.desiredSkills).toEqual(["skill-a", "skill-b"]);
  });

  it("accepts empty desiredSkills array", () => {
    const result = agentSkillSyncSchema.parse({ desiredSkills: [] });
    expect(result.desiredSkills).toEqual([]);
  });

  it("rejects desiredSkills with empty strings", () => {
    expect(() =>
      agentSkillSyncSchema.parse({ desiredSkills: [""] })
    ).toThrow();
  });
});
