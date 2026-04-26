import { describe, expect, it } from "vitest";
import {
  agentSkillStateSchema,
  agentSkillOriginSchema,
  agentSkillSyncModeSchema,
  agentSkillEntrySchema,
  agentSkillSnapshotSchema,
  agentSkillSyncSchema,
} from "./adapter-skills.js";

describe("agentSkillStateSchema", () => {
  it("accepts all valid states", () => {
    for (const state of ["available", "configured", "installed", "missing", "stale", "external"]) {
      expect(agentSkillStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("rejects an invalid state", () => {
    expect(agentSkillStateSchema.safeParse("disabled").success).toBe(false);
  });
});

describe("agentSkillOriginSchema", () => {
  it("accepts all valid origins", () => {
    for (const origin of ["company_managed", "paperclip_required", "user_installed", "external_unknown"]) {
      expect(agentSkillOriginSchema.safeParse(origin).success).toBe(true);
    }
  });

  it("rejects an invalid origin", () => {
    expect(agentSkillOriginSchema.safeParse("admin_installed").success).toBe(false);
  });
});

describe("agentSkillSyncModeSchema", () => {
  it("accepts all valid sync modes", () => {
    for (const mode of ["unsupported", "persistent", "ephemeral"]) {
      expect(agentSkillSyncModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  it("rejects an invalid sync mode", () => {
    expect(agentSkillSyncModeSchema.safeParse("manual").success).toBe(false);
  });
});

describe("agentSkillEntrySchema", () => {
  const minimal = {
    key: "typescript",
    runtimeName: "typescript-lsp",
    desired: true,
    managed: false,
    state: "installed" as const,
  };

  it("accepts a minimal skill entry", () => {
    expect(agentSkillEntrySchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts null runtimeName", () => {
    expect(agentSkillEntrySchema.safeParse({ ...minimal, runtimeName: null }).success).toBe(true);
  });

  it("rejects an empty key", () => {
    expect(agentSkillEntrySchema.safeParse({ ...minimal, key: "" }).success).toBe(false);
  });

  it("accepts all optional fields", () => {
    const result = agentSkillEntrySchema.safeParse({
      ...minimal,
      required: true,
      requiredReason: "Core skill for this role",
      origin: "company_managed",
      originLabel: "Company Managed",
      locationLabel: "/skills/typescript",
      readOnly: false,
      sourcePath: "/skills/typescript",
      targetPath: "/agent/skills/typescript",
      detail: "Version 5.0",
    });
    expect(result.success).toBe(true);
  });
});

describe("agentSkillSnapshotSchema", () => {
  const minimal = {
    adapterType: "claude_local",
    supported: true,
    mode: "persistent" as const,
    desiredSkills: ["typescript"],
    entries: [],
    warnings: [],
  };

  it("accepts a minimal snapshot", () => {
    expect(agentSkillSnapshotSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts an unsupported snapshot with empty desired skills", () => {
    expect(agentSkillSnapshotSchema.safeParse({ ...minimal, supported: false, desiredSkills: [] }).success).toBe(true);
  });

  it("rejects an empty adapterType", () => {
    expect(agentSkillSnapshotSchema.safeParse({ ...minimal, adapterType: "" }).success).toBe(false);
  });

  it("accepts entries array with valid entries", () => {
    const result = agentSkillSnapshotSchema.safeParse({
      ...minimal,
      entries: [{
        key: "ts",
        runtimeName: null,
        desired: true,
        managed: false,
        state: "available",
      }],
    });
    expect(result.success).toBe(true);
  });
});

describe("agentSkillSyncSchema", () => {
  it("accepts a valid sync request", () => {
    expect(agentSkillSyncSchema.safeParse({ desiredSkills: ["typescript", "eslint"] }).success).toBe(true);
  });

  it("accepts an empty desiredSkills array", () => {
    expect(agentSkillSyncSchema.safeParse({ desiredSkills: [] }).success).toBe(true);
  });

  it("rejects desiredSkills containing empty strings", () => {
    expect(agentSkillSyncSchema.safeParse({ desiredSkills: [""] }).success).toBe(false);
  });
});
