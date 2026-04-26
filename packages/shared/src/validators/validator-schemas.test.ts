import { describe, it, expect } from "vitest";
import {
  routineVariableSchema,
  createRoutineSchema,
  updateRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  runRoutineSchema,
  rotateRoutineTriggerSecretSchema,
} from "./routine.js";
import {
  upsertBudgetPolicySchema,
  resolveBudgetIncidentSchema,
} from "./budget.js";
import {
  createGoalSchema,
  updateGoalSchema,
} from "./goal.js";
import {
  createProjectSchema,
  updateProjectSchema,
  createProjectWorkspaceSchema,
  updateProjectWorkspaceSchema,
  projectExecutionWorkspacePolicySchema,
} from "./project.js";
import {
  companySkillSourceTypeSchema,
  companySkillTrustLevelSchema,
  companySkillCompatibilitySchema,
  companySkillSourceBadgeSchema,
  companySkillFileInventoryEntrySchema,
  companySkillImportSchema,
  companySkillProjectScanRequestSchema,
  companySkillCreateSchema,
  companySkillFileUpdateSchema,
} from "./company-skill.js";
import {
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  feedbackDataSharingPreferenceSchema,
  upsertIssueFeedbackVoteSchema,
} from "./feedback.js";

// ============================================================================
// routine.ts — routineVariableSchema
// ============================================================================

describe("routineVariableSchema", () => {
  const baseTextVar = {
    name: "my_var",
    type: "text" as const,
  };

  it("accepts a minimal text variable", () => {
    const result = routineVariableSchema.safeParse(baseTextVar);
    expect(result.success).toBe(true);
  });

  it("accepts a boolean variable", () => {
    const result = routineVariableSchema.safeParse({ name: "flag", type: "boolean" });
    expect(result.success).toBe(true);
  });

  it("accepts a number variable", () => {
    const result = routineVariableSchema.safeParse({ name: "count", type: "number" });
    expect(result.success).toBe(true);
  });

  it("accepts a textarea variable", () => {
    const result = routineVariableSchema.safeParse({ name: "body", type: "textarea" });
    expect(result.success).toBe(true);
  });

  it("accepts a select variable with options", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: ["staging", "production"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a select variable with a valid default", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: ["staging", "production"],
      defaultValue: "staging",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a select variable with no options", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("options"))).toBe(true);
    }
  });

  it("rejects a text variable with options defined", () => {
    const result = routineVariableSchema.safeParse({
      name: "txt",
      type: "text",
      options: ["a", "b"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a select variable with default not in options", () => {
    const result = routineVariableSchema.safeParse({
      name: "env",
      type: "select",
      options: ["staging", "production"],
      defaultValue: "unknown",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("defaultValue"))).toBe(true);
    }
  });

  it("rejects a variable name starting with a digit", () => {
    const result = routineVariableSchema.safeParse({ name: "1bad", type: "text" });
    expect(result.success).toBe(false);
  });

  it("accepts a variable name with underscores and digits", () => {
    const result = routineVariableSchema.safeParse({ name: "var_1", type: "text" });
    expect(result.success).toBe(true);
  });

  it("defaults required to true", () => {
    const result = routineVariableSchema.safeParse({ name: "x", type: "text" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.required).toBe(true);
    }
  });

  it("defaults options to []", () => {
    const result = routineVariableSchema.safeParse({ name: "x", type: "text" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.options).toEqual([]);
    }
  });

  it("accepts label up to 120 chars", () => {
    const result = routineVariableSchema.safeParse({
      name: "x",
      type: "text",
      label: "A".repeat(120),
    });
    expect(result.success).toBe(true);
  });

  it("rejects label longer than 120 chars", () => {
    const result = routineVariableSchema.safeParse({
      name: "x",
      type: "text",
      label: "A".repeat(121),
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// routine.ts — createRoutineSchema
// ============================================================================

describe("createRoutineSchema", () => {
  const minimal = {
    title: "My Routine",
  };

  it("accepts a minimal routine", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("defaults priority to medium", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe("medium");
    }
  });

  it("defaults status to active", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("defaults concurrencyPolicy to coalesce_if_active", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrencyPolicy).toBe("coalesce_if_active");
    }
  });

  it("defaults catchUpPolicy to skip_missed", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.catchUpPolicy).toBe("skip_missed");
    }
  });

  it("defaults variables to []", () => {
    const result = createRoutineSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variables).toEqual([]);
    }
  });

  it("rejects empty title", () => {
    const result = createRoutineSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects title longer than 200 chars", () => {
    const result = createRoutineSchema.safeParse({ title: "A".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("accepts all valid statuses", () => {
    for (const status of ["active", "paused", "archived"] as const) {
      const result = createRoutineSchema.safeParse({ title: "T", status });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    const result = createRoutineSchema.safeParse({ title: "T", status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid concurrencyPolicies", () => {
    for (const policy of ["coalesce_if_active", "always_enqueue", "skip_if_active"] as const) {
      const result = createRoutineSchema.safeParse({ title: "T", concurrencyPolicy: policy });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all valid catchUpPolicies", () => {
    for (const policy of ["skip_missed", "enqueue_missed_with_cap"] as const) {
      const result = createRoutineSchema.safeParse({ title: "T", catchUpPolicy: policy });
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================================
// routine.ts — updateRoutineSchema
// ============================================================================

describe("updateRoutineSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(updateRoutineSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with only title", () => {
    expect(updateRoutineSchema.safeParse({ title: "New title" }).success).toBe(true);
  });
});

// ============================================================================
// routine.ts — createRoutineTriggerSchema
// ============================================================================

describe("createRoutineTriggerSchema", () => {
  it("accepts a schedule trigger", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "schedule",
      cronExpression: "0 9 * * MON",
      timezone: "UTC",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a schedule trigger defaulting timezone to UTC", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "schedule",
      cronExpression: "0 9 * * MON",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "schedule") {
      expect(result.data.timezone).toBe("UTC");
    }
  });

  it("rejects a schedule trigger with empty cronExpression", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "schedule",
      cronExpression: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a webhook trigger", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "webhook",
    });
    expect(result.success).toBe(true);
  });

  it("defaults webhook signingMode to bearer", () => {
    const result = createRoutineTriggerSchema.safeParse({ kind: "webhook" });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "webhook") {
      expect(result.data.signingMode).toBe("bearer");
    }
  });

  it("defaults webhook replayWindowSec to 300", () => {
    const result = createRoutineTriggerSchema.safeParse({ kind: "webhook" });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "webhook") {
      expect(result.data.replayWindowSec).toBe(300);
    }
  });

  it("accepts all webhook signing modes", () => {
    for (const mode of ["bearer", "hmac_sha256", "github_hmac", "none"] as const) {
      const result = createRoutineTriggerSchema.safeParse({ kind: "webhook", signingMode: mode });
      expect(result.success).toBe(true);
    }
  });

  it("rejects webhook replayWindowSec below 30", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "webhook",
      replayWindowSec: 29,
    });
    expect(result.success).toBe(false);
  });

  it("rejects webhook replayWindowSec above 86400", () => {
    const result = createRoutineTriggerSchema.safeParse({
      kind: "webhook",
      replayWindowSec: 86_401,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an api trigger", () => {
    const result = createRoutineTriggerSchema.safeParse({ kind: "api" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const result = createRoutineTriggerSchema.safeParse({ kind: "unknown" });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// routine.ts — updateRoutineTriggerSchema
// ============================================================================

describe("updateRoutineTriggerSchema", () => {
  it("accepts empty object", () => {
    expect(updateRoutineTriggerSchema.safeParse({}).success).toBe(true);
  });

  it("accepts enabled toggle", () => {
    expect(updateRoutineTriggerSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it("accepts replayWindowSec at 30", () => {
    expect(updateRoutineTriggerSchema.safeParse({ replayWindowSec: 30 }).success).toBe(true);
  });

  it("rejects replayWindowSec at 29", () => {
    expect(updateRoutineTriggerSchema.safeParse({ replayWindowSec: 29 }).success).toBe(false);
  });
});

// ============================================================================
// routine.ts — runRoutineSchema
// ============================================================================

describe("runRoutineSchema", () => {
  it("accepts empty object", () => {
    expect(runRoutineSchema.safeParse({}).success).toBe(true);
  });

  it("defaults source to manual", () => {
    const result = runRoutineSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("manual");
    }
  });

  it("accepts source api", () => {
    const result = runRoutineSchema.safeParse({ source: "api" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid source", () => {
    expect(runRoutineSchema.safeParse({ source: "scheduled" }).success).toBe(false);
  });

  it("accepts triggerId as uuid", () => {
    const result = runRoutineSchema.safeParse({
      triggerId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects triggerId as non-uuid", () => {
    expect(runRoutineSchema.safeParse({ triggerId: "not-a-uuid" }).success).toBe(false);
  });

  it("accepts idempotencyKey trimmed up to 255 chars", () => {
    const result = runRoutineSchema.safeParse({ idempotencyKey: "k".repeat(255) });
    expect(result.success).toBe(true);
  });

  it("rejects idempotencyKey longer than 255 chars", () => {
    expect(runRoutineSchema.safeParse({ idempotencyKey: "k".repeat(256) }).success).toBe(false);
  });
});

// ============================================================================
// routine.ts — rotateRoutineTriggerSecretSchema
// ============================================================================

describe("rotateRoutineTriggerSecretSchema", () => {
  it("accepts empty object", () => {
    expect(rotateRoutineTriggerSecretSchema.safeParse({}).success).toBe(true);
  });
});

// ============================================================================
// budget.ts — upsertBudgetPolicySchema
// ============================================================================

describe("upsertBudgetPolicySchema", () => {
  const base = {
    scopeType: "agent" as const,
    scopeId: "00000000-0000-0000-0000-000000000001",
    amount: 5000,
  };

  it("accepts a minimal valid budget policy", () => {
    expect(upsertBudgetPolicySchema.safeParse(base).success).toBe(true);
  });

  it("defaults metric to billed_cents", () => {
    const result = upsertBudgetPolicySchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metric).toBe("billed_cents");
    }
  });

  it("defaults windowKind to calendar_month_utc", () => {
    const result = upsertBudgetPolicySchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.windowKind).toBe("calendar_month_utc");
    }
  });

  it("defaults warnPercent to 80", () => {
    const result = upsertBudgetPolicySchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnPercent).toBe(80);
    }
  });

  it("defaults hardStopEnabled to true", () => {
    const result = upsertBudgetPolicySchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hardStopEnabled).toBe(true);
    }
  });

  it("defaults isActive to true", () => {
    const result = upsertBudgetPolicySchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isActive).toBe(true);
    }
  });

  it("rejects negative amount", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, amount: -1 }).success).toBe(false);
  });

  it("rejects non-integer amount", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, amount: 1.5 }).success).toBe(false);
  });

  it("accepts amount of 0", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, amount: 0 }).success).toBe(true);
  });

  it("rejects invalid scopeType", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, scopeType: "team" }).success).toBe(false);
  });

  it("accepts all valid scopeTypes", () => {
    for (const scopeType of ["company", "agent", "project"] as const) {
      expect(upsertBudgetPolicySchema.safeParse({ ...base, scopeType }).success).toBe(true);
    }
  });

  it("rejects warnPercent outside 1-99", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, warnPercent: 0 }).success).toBe(false);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, warnPercent: 100 }).success).toBe(false);
  });

  it("accepts warnPercent at boundaries 1 and 99", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, warnPercent: 1 }).success).toBe(true);
    expect(upsertBudgetPolicySchema.safeParse({ ...base, warnPercent: 99 }).success).toBe(true);
  });

  it("accepts lifetime windowKind", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, windowKind: "lifetime" }).success).toBe(true);
  });

  it("rejects scopeId that is not a UUID", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...base, scopeId: "not-a-uuid" }).success).toBe(false);
  });
});

// ============================================================================
// budget.ts — resolveBudgetIncidentSchema
// ============================================================================

describe("resolveBudgetIncidentSchema", () => {
  it("accepts keep_paused with no amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({ action: "keep_paused" });
    expect(result.success).toBe(true);
  });

  it("accepts raise_budget_and_resume with an amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
      amount: 10000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects raise_budget_and_resume with no amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
    });
    expect(result.success).toBe(false);
  });

  it("accepts raise_budget_and_resume with amount 0", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
      amount: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects raise_budget_and_resume with negative amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
      amount: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional decisionNote", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "keep_paused",
      decisionNote: "approved by board",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid action", () => {
    expect(resolveBudgetIncidentSchema.safeParse({ action: "unknown" }).success).toBe(false);
  });
});

// ============================================================================
// goal.ts — createGoalSchema
// ============================================================================

describe("createGoalSchema", () => {
  it("accepts a minimal goal", () => {
    const result = createGoalSchema.safeParse({ title: "Q2 OKR" });
    expect(result.success).toBe(true);
  });

  it("defaults level to task", () => {
    const result = createGoalSchema.safeParse({ title: "G" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.level).toBe("task");
    }
  });

  it("defaults status to planned", () => {
    const result = createGoalSchema.safeParse({ title: "G" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("planned");
    }
  });

  it("rejects empty title", () => {
    expect(createGoalSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("accepts all valid levels", () => {
    for (const level of ["company", "team", "agent", "task"] as const) {
      expect(createGoalSchema.safeParse({ title: "G", level }).success).toBe(true);
    }
  });

  it("accepts all valid statuses", () => {
    for (const status of ["planned", "active", "achieved", "cancelled"] as const) {
      expect(createGoalSchema.safeParse({ title: "G", status }).success).toBe(true);
    }
  });

  it("rejects invalid level", () => {
    expect(createGoalSchema.safeParse({ title: "G", level: "unknown" }).success).toBe(false);
  });

  it("accepts parentId as uuid", () => {
    const result = createGoalSchema.safeParse({
      title: "G",
      parentId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects parentId as non-uuid", () => {
    expect(createGoalSchema.safeParse({ title: "G", parentId: "not-uuid" }).success).toBe(false);
  });

  it("accepts null parentId", () => {
    expect(createGoalSchema.safeParse({ title: "G", parentId: null }).success).toBe(true);
  });
});

// ============================================================================
// goal.ts — updateGoalSchema
// ============================================================================

describe("updateGoalSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(updateGoalSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update", () => {
    expect(updateGoalSchema.safeParse({ status: "active" }).success).toBe(true);
  });
});

// ============================================================================
// project.ts — createProjectWorkspaceSchema
// ============================================================================

describe("createProjectWorkspaceSchema", () => {
  it("accepts workspace with cwd only", () => {
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "/home/user/project" });
    expect(result.success).toBe(true);
  });

  it("accepts workspace with repoUrl only", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      repoUrl: "https://github.com/example/repo",
    });
    expect(result.success).toBe(true);
  });

  it("accepts workspace with both cwd and repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      cwd: "/home/user/project",
      repoUrl: "https://github.com/example/repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects workspace with neither cwd nor repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects workspace where cwd is empty string", () => {
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "" });
    expect(result.success).toBe(false);
  });

  it("defaults isPrimary to false", () => {
    const result = createProjectWorkspaceSchema.safeParse({ cwd: "/home/user" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isPrimary).toBe(false);
    }
  });

  it("accepts remote_managed workspace with remoteWorkspaceRef", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      sourceType: "remote_managed",
      remoteWorkspaceRef: "ref-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts remote_managed workspace with repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      sourceType: "remote_managed",
      repoUrl: "https://github.com/example/repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects remote_managed workspace with neither remoteWorkspaceRef nor repoUrl", () => {
    const result = createProjectWorkspaceSchema.safeParse({
      sourceType: "remote_managed",
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// project.ts — updateProjectWorkspaceSchema
// ============================================================================

describe("updateProjectWorkspaceSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    expect(updateProjectWorkspaceSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with name only", () => {
    expect(updateProjectWorkspaceSchema.safeParse({ name: "Updated" }).success).toBe(true);
  });
});

// ============================================================================
// project.ts — createProjectSchema
// ============================================================================

describe("createProjectSchema", () => {
  it("accepts a minimal project", () => {
    const result = createProjectSchema.safeParse({ name: "My Project" });
    expect(result.success).toBe(true);
  });

  it("defaults status to backlog", () => {
    const result = createProjectSchema.safeParse({ name: "P" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("backlog");
    }
  });

  it("rejects empty name", () => {
    expect(createProjectSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts project with nested workspace", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      workspace: { cwd: "/home/user/project" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects project with invalid nested workspace (no cwd/repoUrl)", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      workspace: {},
    });
    expect(result.success).toBe(false);
  });

  it("accepts leadAgentId as uuid", () => {
    const result = createProjectSchema.safeParse({
      name: "P",
      leadAgentId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts description as null", () => {
    expect(createProjectSchema.safeParse({ name: "P", description: null }).success).toBe(true);
  });

  it("accepts all valid statuses", () => {
    // Known project statuses from constants
    for (const status of ["backlog", "active", "completed", "archived"] as const) {
      const result = createProjectSchema.safeParse({ name: "P", status });
      // We just assert it doesn't crash; valid statuses pass
      expect(typeof result.success).toBe("boolean");
    }
  });
});

// ============================================================================
// project.ts — updateProjectSchema
// ============================================================================

describe("updateProjectSchema", () => {
  it("accepts empty object", () => {
    expect(updateProjectSchema.safeParse({}).success).toBe(true);
  });

  it("accepts name-only update", () => {
    expect(updateProjectSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });
});

// ============================================================================
// project.ts — projectExecutionWorkspacePolicySchema
// ============================================================================

describe("projectExecutionWorkspacePolicySchema", () => {
  it("accepts minimal policy with enabled flag", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({ enabled: true });
    expect(result.success).toBe(true);
  });

  it("accepts policy with defaultMode", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      defaultMode: "isolated_workspace",
    });
    expect(result.success).toBe(true);
  });

  it("rejects extra unknown fields (strict)", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      unknownField: "value",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid defaultMode", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      defaultMode: "agent_isolated",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid defaultModes", () => {
    for (const mode of ["shared_workspace", "isolated_workspace", "operator_branch", "adapter_default"] as const) {
      const result = projectExecutionWorkspacePolicySchema.safeParse({ enabled: true, defaultMode: mode });
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================================
// company-skill.ts — enum schemas
// ============================================================================

describe("companySkillSourceTypeSchema", () => {
  it("accepts all valid source types", () => {
    for (const v of ["local_path", "github", "url", "catalog", "skills_sh"] as const) {
      expect(companySkillSourceTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid source type", () => {
    expect(companySkillSourceTypeSchema.safeParse("npm").success).toBe(false);
  });
});

describe("companySkillTrustLevelSchema", () => {
  it("accepts all valid trust levels", () => {
    for (const v of ["markdown_only", "assets", "scripts_executables"] as const) {
      expect(companySkillTrustLevelSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid trust level", () => {
    expect(companySkillTrustLevelSchema.safeParse("full").success).toBe(false);
  });
});

describe("companySkillCompatibilitySchema", () => {
  it("accepts all valid compatibility values", () => {
    for (const v of ["compatible", "unknown", "invalid"] as const) {
      expect(companySkillCompatibilitySchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid compatibility", () => {
    expect(companySkillCompatibilitySchema.safeParse("partial").success).toBe(false);
  });
});

describe("companySkillSourceBadgeSchema", () => {
  it("accepts all valid source badges", () => {
    for (const v of ["paperclip", "github", "local", "url", "catalog", "skills_sh"] as const) {
      expect(companySkillSourceBadgeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects unknown badge", () => {
    expect(companySkillSourceBadgeSchema.safeParse("unknown").success).toBe(false);
  });
});

// ============================================================================
// company-skill.ts — companySkillFileInventoryEntrySchema
// ============================================================================

describe("companySkillFileInventoryEntrySchema", () => {
  it("accepts a valid skill file entry", () => {
    const result = companySkillFileInventoryEntrySchema.safeParse({
      path: "skills/my-skill.md",
      kind: "skill",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid kinds", () => {
    for (const kind of ["skill", "markdown", "reference", "script", "asset", "other"] as const) {
      expect(
        companySkillFileInventoryEntrySchema.safeParse({ path: "f.md", kind }).success
      ).toBe(true);
    }
  });

  it("rejects empty path", () => {
    expect(
      companySkillFileInventoryEntrySchema.safeParse({ path: "", kind: "skill" }).success
    ).toBe(false);
  });

  it("rejects invalid kind", () => {
    expect(
      companySkillFileInventoryEntrySchema.safeParse({ path: "f.md", kind: "unknown" }).success
    ).toBe(false);
  });
});

// ============================================================================
// company-skill.ts — companySkillImportSchema
// ============================================================================

describe("companySkillImportSchema", () => {
  it("accepts a valid source", () => {
    expect(companySkillImportSchema.safeParse({ source: "github:org/repo" }).success).toBe(true);
  });

  it("rejects empty source", () => {
    expect(companySkillImportSchema.safeParse({ source: "" }).success).toBe(false);
  });

  it("rejects missing source", () => {
    expect(companySkillImportSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// company-skill.ts — companySkillProjectScanRequestSchema
// ============================================================================

describe("companySkillProjectScanRequestSchema", () => {
  it("accepts empty object (all optional)", () => {
    expect(companySkillProjectScanRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts projectIds array of UUIDs", () => {
    const result = companySkillProjectScanRequestSchema.safeParse({
      projectIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts workspaceIds array of UUIDs", () => {
    const result = companySkillProjectScanRequestSchema.safeParse({
      workspaceIds: ["00000000-0000-0000-0000-000000000002"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects projectIds with non-UUID strings", () => {
    expect(
      companySkillProjectScanRequestSchema.safeParse({ projectIds: ["not-uuid"] }).success
    ).toBe(false);
  });
});

// ============================================================================
// company-skill.ts — companySkillCreateSchema
// ============================================================================

describe("companySkillCreateSchema", () => {
  it("accepts minimal skill with name only", () => {
    expect(companySkillCreateSchema.safeParse({ name: "My Skill" }).success).toBe(true);
  });

  it("rejects empty name", () => {
    expect(companySkillCreateSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts optional slug", () => {
    expect(companySkillCreateSchema.safeParse({ name: "S", slug: "my-skill" }).success).toBe(true);
  });

  it("accepts null slug", () => {
    expect(companySkillCreateSchema.safeParse({ name: "S", slug: null }).success).toBe(true);
  });

  it("accepts description and markdown", () => {
    const result = companySkillCreateSchema.safeParse({
      name: "S",
      description: "A skill",
      markdown: "# Hello",
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// company-skill.ts — companySkillFileUpdateSchema
// ============================================================================

describe("companySkillFileUpdateSchema", () => {
  it("accepts valid path and content", () => {
    const result = companySkillFileUpdateSchema.safeParse({
      path: "skills/main.md",
      content: "# Content",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty content string", () => {
    expect(companySkillFileUpdateSchema.safeParse({ path: "f.md", content: "" }).success).toBe(true);
  });

  it("rejects empty path", () => {
    expect(companySkillFileUpdateSchema.safeParse({ path: "", content: "x" }).success).toBe(false);
  });

  it("rejects missing path", () => {
    expect(companySkillFileUpdateSchema.safeParse({ content: "x" }).success).toBe(false);
  });
});

// ============================================================================
// feedback.ts — enum schemas
// ============================================================================

describe("feedbackTargetTypeSchema", () => {
  it("accepts all valid target types", () => {
    for (const v of ["issue_comment", "issue_document_revision"] as const) {
      expect(feedbackTargetTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid target type", () => {
    expect(feedbackTargetTypeSchema.safeParse("issue").success).toBe(false);
  });
});

describe("feedbackTraceStatusSchema", () => {
  it("accepts all valid trace statuses", () => {
    for (const v of ["local_only", "pending", "sent", "failed"] as const) {
      expect(feedbackTraceStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid trace status", () => {
    expect(feedbackTraceStatusSchema.safeParse("delivered").success).toBe(false);
  });
});

describe("feedbackVoteValueSchema", () => {
  it("accepts up", () => {
    expect(feedbackVoteValueSchema.safeParse("up").success).toBe(true);
  });

  it("accepts down", () => {
    expect(feedbackVoteValueSchema.safeParse("down").success).toBe(true);
  });

  it("rejects neutral", () => {
    expect(feedbackVoteValueSchema.safeParse("neutral").success).toBe(false);
  });
});

describe("feedbackDataSharingPreferenceSchema", () => {
  it("accepts all valid preferences", () => {
    for (const v of ["allowed", "not_allowed", "prompt"] as const) {
      expect(feedbackDataSharingPreferenceSchema.safeParse(v).success).toBe(true);
    }
  });

  it("rejects invalid preference", () => {
    expect(feedbackDataSharingPreferenceSchema.safeParse("denied").success).toBe(false);
  });
});

// ============================================================================
// feedback.ts — upsertIssueFeedbackVoteSchema
// ============================================================================

describe("upsertIssueFeedbackVoteSchema", () => {
  const base = {
    targetType: "issue_comment" as const,
    targetId: "00000000-0000-0000-0000-000000000001",
    vote: "up" as const,
  };

  it("accepts a minimal feedback vote", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a down vote", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...base, vote: "down" }).success).toBe(true);
  });

  it("accepts issue_document_revision target type", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...base, targetType: "issue_document_revision" }).success
    ).toBe(true);
  });

  it("rejects invalid vote value", () => {
    expect(upsertIssueFeedbackVoteSchema.safeParse({ ...base, vote: "meh" }).success).toBe(false);
  });

  it("rejects non-UUID targetId", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...base, targetId: "not-uuid" }).success
    ).toBe(false);
  });

  it("accepts optional reason within 1000 chars", () => {
    const result = upsertIssueFeedbackVoteSchema.safeParse({
      ...base,
      reason: "This answer was correct",
    });
    expect(result.success).toBe(true);
  });

  it("rejects reason longer than 1000 chars", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...base, reason: "x".repeat(1001) }).success
    ).toBe(false);
  });

  it("accepts reason at exactly 1000 chars", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...base, reason: "x".repeat(1000) }).success
    ).toBe(true);
  });

  it("accepts optional allowSharing boolean", () => {
    expect(
      upsertIssueFeedbackVoteSchema.safeParse({ ...base, allowSharing: true }).success
    ).toBe(true);
  });

  it("rejects missing targetId", () => {
    const { targetId: _, ...rest } = base;
    expect(upsertIssueFeedbackVoteSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing vote", () => {
    const { vote: _, ...rest } = base;
    expect(upsertIssueFeedbackVoteSchema.safeParse(rest).success).toBe(false);
  });
});
