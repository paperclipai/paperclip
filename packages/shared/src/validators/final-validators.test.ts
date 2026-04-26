import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// agent.ts
// ---------------------------------------------------------------------------
import {
  agentPermissionsSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  createAgentSchema,
  updateAgentSchema,
  createAgentKeySchema,
  agentMineInboxQuerySchema,
  wakeAgentSchema,
  resetAgentSessionSchema,
  updateAgentPermissionsSchema,
} from "./agent.js";

// ---------------------------------------------------------------------------
// work-product.ts
// ---------------------------------------------------------------------------
import {
  createIssueWorkProductSchema,
  updateIssueWorkProductSchema,
} from "./work-product.js";

// ---------------------------------------------------------------------------
// goal.ts — re-exported from index or direct
// ---------------------------------------------------------------------------
import { createGoalSchema, updateGoalSchema } from "./goal.js";

// ---------------------------------------------------------------------------
// asset.ts
// ---------------------------------------------------------------------------
import { createAssetImageMetadataSchema } from "./asset.js";

// ---------------------------------------------------------------------------
// instance.ts
// ---------------------------------------------------------------------------
import {
  backupRetentionPolicySchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

// ============================================================================
// agent.ts — agentPermissionsSchema
// ============================================================================

describe("agentPermissionsSchema", () => {
  it("defaults canCreateAgents to false", () => {
    const result = agentPermissionsSchema.parse({});
    expect(result.canCreateAgents).toBe(false);
  });

  it("accepts canCreateAgents=true", () => {
    const result = agentPermissionsSchema.parse({ canCreateAgents: true });
    expect(result.canCreateAgents).toBe(true);
  });
});

// ============================================================================
// agent.ts — updateAgentInstructionsBundleSchema
// ============================================================================

describe("updateAgentInstructionsBundleSchema", () => {
  it("defaults clearLegacyPromptTemplate to false", () => {
    const result = updateAgentInstructionsBundleSchema.parse({});
    expect(result.clearLegacyPromptTemplate).toBe(false);
  });

  it("accepts mode 'managed'", () => {
    const result = updateAgentInstructionsBundleSchema.parse({ mode: "managed" });
    expect(result.mode).toBe("managed");
  });

  it("accepts mode 'external'", () => {
    const result = updateAgentInstructionsBundleSchema.parse({ mode: "external" });
    expect(result.mode).toBe("external");
  });

  it("rejects invalid mode", () => {
    expect(() =>
      updateAgentInstructionsBundleSchema.parse({ mode: "inline" })
    ).toThrow();
  });

  it("rejects empty rootPath", () => {
    expect(() =>
      updateAgentInstructionsBundleSchema.parse({ rootPath: "" })
    ).toThrow();
  });

  it("accepts null rootPath", () => {
    const result = updateAgentInstructionsBundleSchema.parse({ rootPath: null });
    expect(result.rootPath).toBeNull();
  });
});

// ============================================================================
// agent.ts — upsertAgentInstructionsFileSchema
// ============================================================================

describe("upsertAgentInstructionsFileSchema", () => {
  it("parses a valid file upsert", () => {
    const result = upsertAgentInstructionsFileSchema.parse({
      path: "CLAUDE.md",
      content: "# Agent Instructions",
    });
    expect(result.path).toBe("CLAUDE.md");
    expect(result.content).toBe("# Agent Instructions");
  });

  it("rejects empty path", () => {
    expect(() =>
      upsertAgentInstructionsFileSchema.parse({ path: "", content: "x" })
    ).toThrow();
  });

  it("defaults clearLegacyPromptTemplate to false", () => {
    const result = upsertAgentInstructionsFileSchema.parse({
      path: "p",
      content: "c",
    });
    expect(result.clearLegacyPromptTemplate).toBe(false);
  });
});

// ============================================================================
// agent.ts — createAgentSchema
// ============================================================================

describe("createAgentSchema", () => {
  it("parses a minimal agent (name required)", () => {
    const result = createAgentSchema.parse({
      name: "MyAgent",
      adapterType: "claude_local",
    });
    expect(result.name).toBe("MyAgent");
    expect(result.role).toBe("general");
    expect(result.budgetMonthlyCents).toBe(0);
  });

  it("rejects empty name", () => {
    expect(() =>
      createAgentSchema.parse({ name: "", adapterType: "claude_local" })
    ).toThrow();
  });

  it("defaults adapterConfig to empty object", () => {
    const result = createAgentSchema.parse({
      name: "a",
      adapterType: "claude_local",
    });
    expect(result.adapterConfig).toEqual({});
  });

  it("rejects negative budgetMonthlyCents", () => {
    expect(() =>
      createAgentSchema.parse({ name: "a", adapterType: "claude_local", budgetMonthlyCents: -1 })
    ).toThrow();
  });

  it("accepts adapterConfig with valid env bindings", () => {
    const result = createAgentSchema.parse({
      name: "a",
      adapterType: "claude_local",
      adapterConfig: { env: { FOO: "bar" } },
    });
    expect(result.adapterConfig.env).toEqual({ FOO: "bar" });
  });

  it("rejects adapterConfig with invalid env bindings", () => {
    expect(() =>
      createAgentSchema.parse({
        name: "a",
        adapterType: "claude_local",
        adapterConfig: { env: { FOO: 123 } },
      })
    ).toThrow(/env must be a map of valid env bindings/i);
  });
});

// ============================================================================
// agent.ts — updateAgentSchema
// ============================================================================

describe("updateAgentSchema", () => {
  it("parses an empty object (all partial)", () => {
    const result = updateAgentSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateAgentSchema.parse({ name: "New Name" });
    expect(result.name).toBe("New Name");
  });

  it("accepts replaceAdapterConfig flag", () => {
    const result = updateAgentSchema.parse({ replaceAdapterConfig: true });
    expect(result.replaceAdapterConfig).toBe(true);
  });
});

// ============================================================================
// agent.ts — createAgentKeySchema
// ============================================================================

describe("createAgentKeySchema", () => {
  it("defaults name to 'default'", () => {
    const result = createAgentKeySchema.parse({});
    expect(result.name).toBe("default");
  });

  it("accepts a custom name", () => {
    const result = createAgentKeySchema.parse({ name: "prod" });
    expect(result.name).toBe("prod");
  });
});

// ============================================================================
// agent.ts — agentMineInboxQuerySchema
// ============================================================================

describe("agentMineInboxQuerySchema", () => {
  it("parses with required userId", () => {
    const result = agentMineInboxQuerySchema.parse({ userId: "user-123" });
    expect(result.userId).toBe("user-123");
  });

  it("rejects empty userId", () => {
    expect(() => agentMineInboxQuerySchema.parse({ userId: "" })).toThrow();
  });

  it("has a default status", () => {
    const result = agentMineInboxQuerySchema.parse({ userId: "u" });
    expect(typeof result.status).toBe("string");
    expect(result.status.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// agent.ts — wakeAgentSchema
// ============================================================================

describe("wakeAgentSchema", () => {
  it("defaults source to 'on_demand'", () => {
    const result = wakeAgentSchema.parse({});
    expect(result.source).toBe("on_demand");
  });

  it("defaults forceFreshSession to false", () => {
    const result = wakeAgentSchema.parse({});
    expect(result.forceFreshSession).toBe(false);
  });

  it("coerces null forceFreshSession to undefined (then defaults false)", () => {
    const result = wakeAgentSchema.parse({ forceFreshSession: null });
    expect(result.forceFreshSession).toBe(false);
  });

  it("accepts source 'timer'", () => {
    const result = wakeAgentSchema.parse({ source: "timer" });
    expect(result.source).toBe("timer");
  });

  it("rejects invalid source", () => {
    expect(() => wakeAgentSchema.parse({ source: "push" })).toThrow();
  });

  it("accepts a reason string", () => {
    const result = wakeAgentSchema.parse({ reason: "scheduled run" });
    expect(result.reason).toBe("scheduled run");
  });
});

// ============================================================================
// agent.ts — resetAgentSessionSchema
// ============================================================================

describe("resetAgentSessionSchema", () => {
  it("parses empty object", () => {
    const result = resetAgentSessionSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts optional taskKey", () => {
    const result = resetAgentSessionSchema.parse({ taskKey: "my-task" });
    expect(result.taskKey).toBe("my-task");
  });
});

// ============================================================================
// agent.ts — updateAgentPermissionsSchema
// ============================================================================

describe("updateAgentPermissionsSchema", () => {
  it("parses both required fields", () => {
    const result = updateAgentPermissionsSchema.parse({
      canCreateAgents: true,
      canAssignTasks: false,
    });
    expect(result.canCreateAgents).toBe(true);
    expect(result.canAssignTasks).toBe(false);
  });

  it("rejects missing canAssignTasks", () => {
    expect(() =>
      updateAgentPermissionsSchema.parse({ canCreateAgents: true })
    ).toThrow();
  });
});

// ============================================================================
// work-product.ts
// ============================================================================

describe("createIssueWorkProductSchema", () => {
  const validBase = {
    type: "pull_request",
    provider: "github",
    title: "My PR",
  };

  it("parses a valid work product", () => {
    const result = createIssueWorkProductSchema.parse(validBase);
    expect(result.type).toBe("pull_request");
    expect(result.status).toBe("active");
    expect(result.reviewState).toBe("none");
    expect(result.isPrimary).toBe(false);
    expect(result.healthStatus).toBe("unknown");
  });

  it("rejects invalid type", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({ ...validBase, type: "ticket" })
    ).toThrow();
  });

  it("rejects empty provider", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({ ...validBase, provider: "" })
    ).toThrow();
  });

  it("rejects empty title", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({ ...validBase, title: "" })
    ).toThrow();
  });

  it("accepts a valid URL", () => {
    const result = createIssueWorkProductSchema.parse({
      ...validBase,
      url: "https://github.com/acme/repo/pull/1",
    });
    expect(result.url).toBe("https://github.com/acme/repo/pull/1");
  });

  it("rejects an invalid URL", () => {
    expect(() =>
      createIssueWorkProductSchema.parse({ ...validBase, url: "not-a-url" })
    ).toThrow();
  });

  it("accepts reviewState 'approved'", () => {
    const result = createIssueWorkProductSchema.parse({
      ...validBase,
      reviewState: "approved",
    });
    expect(result.reviewState).toBe("approved");
  });
});

describe("updateIssueWorkProductSchema", () => {
  it("parses an empty object (all partial)", () => {
    const result = updateIssueWorkProductSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateIssueWorkProductSchema.parse({ status: "merged" });
    expect(result.status).toBe("merged");
  });
});

// ============================================================================
// goal.ts
// ============================================================================

describe("createGoalSchema", () => {
  it("parses a minimal goal", () => {
    const result = createGoalSchema.parse({ title: "Q1 OKRs" });
    expect(result.title).toBe("Q1 OKRs");
    expect(result.level).toBe("task");
    expect(result.status).toBe("planned");
  });

  it("rejects empty title", () => {
    expect(() => createGoalSchema.parse({ title: "" })).toThrow();
  });

  it("accepts a valid level", () => {
    const result = createGoalSchema.parse({ title: "t", level: "team" });
    expect(result.level).toBe("team");
  });

  it("rejects invalid level", () => {
    expect(() => createGoalSchema.parse({ title: "t", level: "epic" })).toThrow();
  });

  it("accepts optional parentId UUID", () => {
    const id = "00000000-0000-0000-0000-000000000007";
    const result = createGoalSchema.parse({ title: "t", parentId: id });
    expect(result.parentId).toBe(id);
  });

  it("rejects non-UUID parentId", () => {
    expect(() => createGoalSchema.parse({ title: "t", parentId: "bad" })).toThrow();
  });
});

describe("updateGoalSchema", () => {
  it("parses an empty object", () => {
    const result = updateGoalSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts status update", () => {
    const result = updateGoalSchema.parse({ status: "achieved" });
    expect(result.status).toBe("achieved");
  });
});

// ============================================================================
// asset.ts
// ============================================================================

describe("createAssetImageMetadataSchema", () => {
  it("parses empty object (namespace optional)", () => {
    const result = createAssetImageMetadataSchema.parse({});
    expect(result.namespace).toBeUndefined();
  });

  it("accepts a valid namespace", () => {
    const result = createAssetImageMetadataSchema.parse({ namespace: "company/logos" });
    expect(result.namespace).toBe("company/logos");
  });

  it("rejects namespaces with invalid characters", () => {
    expect(() =>
      createAssetImageMetadataSchema.parse({ namespace: "company logos" })
    ).toThrow();
    expect(() =>
      createAssetImageMetadataSchema.parse({ namespace: "co!logo" })
    ).toThrow();
  });

  it("rejects empty namespace", () => {
    expect(() =>
      createAssetImageMetadataSchema.parse({ namespace: "" })
    ).toThrow();
  });

  it("rejects namespace over 120 chars", () => {
    expect(() =>
      createAssetImageMetadataSchema.parse({ namespace: "a".repeat(121) })
    ).toThrow();
  });
});

// ============================================================================
// instance.ts
// ============================================================================

describe("backupRetentionPolicySchema", () => {
  it("parses with defaults", () => {
    const result = backupRetentionPolicySchema.parse({});
    expect(typeof result.dailyDays).toBe("number");
    expect(typeof result.weeklyWeeks).toBe("number");
    expect(typeof result.monthlyMonths).toBe("number");
  });

  it("rejects arbitrary numbers that are not in presets", () => {
    // 3 is actually a valid dailyDays preset; use a clearly invalid one
    expect(() =>
      backupRetentionPolicySchema.parse({ dailyDays: 5 })
    ).toThrow(/dailyDays/);
  });
});

describe("instanceGeneralSettingsSchema", () => {
  it("parses with defaults", () => {
    const result = instanceGeneralSettingsSchema.parse({});
    expect(result.censorUsernameInLogs).toBe(false);
    expect(result.keyboardShortcuts).toBe(false);
  });

  it("accepts censorUsernameInLogs=true", () => {
    const result = instanceGeneralSettingsSchema.parse({ censorUsernameInLogs: true });
    expect(result.censorUsernameInLogs).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      instanceGeneralSettingsSchema.parse({ unknownField: true })
    ).toThrow();
  });
});

describe("patchInstanceGeneralSettingsSchema", () => {
  it("parses empty object", () => {
    const result = patchInstanceGeneralSettingsSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = patchInstanceGeneralSettingsSchema.parse({ keyboardShortcuts: true });
    expect(result.keyboardShortcuts).toBe(true);
  });
});

describe("instanceExperimentalSettingsSchema", () => {
  it("defaults both flags to false", () => {
    const result = instanceExperimentalSettingsSchema.parse({});
    expect(result.enableIsolatedWorkspaces).toBe(false);
    expect(result.autoRestartDevServerWhenIdle).toBe(false);
  });

  it("accepts enableIsolatedWorkspaces=true", () => {
    const result = instanceExperimentalSettingsSchema.parse({ enableIsolatedWorkspaces: true });
    expect(result.enableIsolatedWorkspaces).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      instanceExperimentalSettingsSchema.parse({ someNewFlag: true })
    ).toThrow();
  });
});

describe("patchInstanceExperimentalSettingsSchema", () => {
  it("parses empty object", () => {
    const result = patchInstanceExperimentalSettingsSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts one flag at a time", () => {
    const result = patchInstanceExperimentalSettingsSchema.parse({
      autoRestartDevServerWhenIdle: true,
    });
    expect(result.autoRestartDevServerWhenIdle).toBe(true);
  });
});
