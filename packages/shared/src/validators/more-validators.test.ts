import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// routine.ts
// ---------------------------------------------------------------------------
import {
  routineVariableSchema,
  createRoutineSchema,
  createRoutineTriggerSchema,
  updateRoutineTriggerSchema,
  runRoutineSchema,
} from "./routine.js";

// ---------------------------------------------------------------------------
// company.ts
// ---------------------------------------------------------------------------
import {
  createCompanySchema,
  updateCompanySchema,
  updateCompanyBrandingSchema,
} from "./company.js";

// ---------------------------------------------------------------------------
// project.ts
// ---------------------------------------------------------------------------
import {
  createProjectWorkspaceSchema,
  updateProjectWorkspaceSchema,
  projectExecutionWorkspacePolicySchema,
  createProjectSchema,
  updateProjectSchema,
} from "./project.js";

// ============================================================================
// routine.ts — routineVariableSchema
// ============================================================================

describe("routineVariableSchema", () => {
  it("parses a basic text variable", () => {
    const result = routineVariableSchema.parse({ name: "myVar" });
    expect(result.name).toBe("myVar");
    expect(result.type).toBe("text");
    expect(result.required).toBe(true);
    expect(result.options).toEqual([]);
  });

  it("rejects names that don't start with a letter", () => {
    expect(() => routineVariableSchema.parse({ name: "1bad" })).toThrow();
    expect(() => routineVariableSchema.parse({ name: "_bad" })).toThrow();
  });

  it("accepts names with letters, digits, and underscores after the first character", () => {
    const result = routineVariableSchema.parse({ name: "my_Var2" });
    expect(result.name).toBe("my_Var2");
  });

  it("rejects a select variable with no options", () => {
    expect(() =>
      routineVariableSchema.parse({ name: "x", type: "select", options: [] })
    ).toThrow(/at least one option/i);
  });

  it("parses a valid select variable with options", () => {
    const result = routineVariableSchema.parse({
      name: "x",
      type: "select",
      options: ["a", "b"],
    });
    expect(result.options).toEqual(["a", "b"]);
  });

  it("rejects options on a non-select variable", () => {
    expect(() =>
      routineVariableSchema.parse({ name: "x", type: "text", options: ["a"] })
    ).toThrow(/Only select variables/i);
  });

  it("rejects a select defaultValue not in options", () => {
    expect(() =>
      routineVariableSchema.parse({
        name: "x",
        type: "select",
        options: ["a", "b"],
        defaultValue: "c",
      })
    ).toThrow(/match one of the allowed options/i);
  });

  it("accepts a select defaultValue that is in options", () => {
    const result = routineVariableSchema.parse({
      name: "x",
      type: "select",
      options: ["a", "b"],
      defaultValue: "a",
    });
    expect(result.defaultValue).toBe("a");
  });

  it("accepts a numeric defaultValue for text variables", () => {
    const result = routineVariableSchema.parse({ name: "x", defaultValue: 42 });
    expect(result.defaultValue).toBe(42);
  });

  it("accepts label with max 120 chars", () => {
    const result = routineVariableSchema.parse({ name: "x", label: "a".repeat(120) });
    expect(result.label).toHaveLength(120);
  });

  it("rejects label over 120 chars", () => {
    expect(() => routineVariableSchema.parse({ name: "x", label: "a".repeat(121) })).toThrow();
  });
});

// ============================================================================
// routine.ts — createRoutineSchema
// ============================================================================

describe("createRoutineSchema", () => {
  it("parses a minimal routine", () => {
    const result = createRoutineSchema.parse({ title: "Daily Sync" });
    expect(result.title).toBe("Daily Sync");
    expect(result.priority).toBe("medium");
    expect(result.status).toBe("active");
    expect(result.concurrencyPolicy).toBe("coalesce_if_active");
    expect(result.catchUpPolicy).toBe("skip_missed");
    expect(result.variables).toEqual([]);
  });

  it("rejects empty title", () => {
    expect(() => createRoutineSchema.parse({ title: "" })).toThrow();
  });

  it("rejects title over 200 chars", () => {
    expect(() => createRoutineSchema.parse({ title: "x".repeat(201) })).toThrow();
  });

  it("accepts variables array", () => {
    const result = createRoutineSchema.parse({
      title: "t",
      variables: [{ name: "myVar" }],
    });
    expect(result.variables).toHaveLength(1);
  });
});

// ============================================================================
// routine.ts — createRoutineTriggerSchema
// ============================================================================

describe("createRoutineTriggerSchema", () => {
  it("parses a schedule trigger", () => {
    const result = createRoutineTriggerSchema.parse({
      kind: "schedule",
      cronExpression: "0 9 * * 1-5",
    });
    expect(result.kind).toBe("schedule");
    if (result.kind === "schedule") {
      expect(result.timezone).toBe("UTC");
    }
  });

  it("parses a webhook trigger with defaults", () => {
    const result = createRoutineTriggerSchema.parse({ kind: "webhook" });
    expect(result.kind).toBe("webhook");
    if (result.kind === "webhook") {
      expect(result.signingMode).toBe("bearer");
      expect(result.replayWindowSec).toBe(300);
    }
  });

  it("parses an api trigger", () => {
    const result = createRoutineTriggerSchema.parse({ kind: "api" });
    expect(result.kind).toBe("api");
  });

  it("rejects invalid kind", () => {
    expect(() => createRoutineTriggerSchema.parse({ kind: "cron" })).toThrow();
  });

  it("rejects schedule trigger with empty cronExpression", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({ kind: "schedule", cronExpression: "" })
    ).toThrow();
  });

  it("defaults enabled to true", () => {
    const result = createRoutineTriggerSchema.parse({ kind: "api" });
    expect(result.enabled).toBe(true);
  });

  it("rejects replayWindowSec below 30", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({ kind: "webhook", replayWindowSec: 29 })
    ).toThrow();
  });

  it("rejects replayWindowSec above 86400", () => {
    expect(() =>
      createRoutineTriggerSchema.parse({ kind: "webhook", replayWindowSec: 86401 })
    ).toThrow();
  });
});

// ============================================================================
// routine.ts — updateRoutineTriggerSchema
// ============================================================================

describe("updateRoutineTriggerSchema", () => {
  it("parses an empty object (all optional)", () => {
    const result = updateRoutineTriggerSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateRoutineTriggerSchema.parse({ enabled: false });
    expect(result.enabled).toBe(false);
  });
});

// ============================================================================
// routine.ts — runRoutineSchema
// ============================================================================

describe("runRoutineSchema", () => {
  it("parses an empty object with defaults", () => {
    const result = runRoutineSchema.parse({});
    expect(result.source).toBe("manual");
  });

  it("accepts 'api' source", () => {
    const result = runRoutineSchema.parse({ source: "api" });
    expect(result.source).toBe("api");
  });

  it("accepts an idempotencyKey", () => {
    const result = runRoutineSchema.parse({ idempotencyKey: "run-abc-123" });
    expect(result.idempotencyKey).toBe("run-abc-123");
  });

  it("rejects idempotencyKey over 255 chars", () => {
    expect(() => runRoutineSchema.parse({ idempotencyKey: "x".repeat(256) })).toThrow();
  });
});

// ============================================================================
// company.ts
// ============================================================================

describe("createCompanySchema", () => {
  it("parses a valid company", () => {
    const result = createCompanySchema.parse({ name: "Acme Inc" });
    expect(result.name).toBe("Acme Inc");
    expect(result.budgetMonthlyCents).toBe(0);
  });

  it("rejects empty name", () => {
    expect(() => createCompanySchema.parse({ name: "" })).toThrow();
  });

  it("rejects negative budgetMonthlyCents", () => {
    expect(() => createCompanySchema.parse({ name: "Acme", budgetMonthlyCents: -1 })).toThrow();
  });

  it("rejects fractional budgetMonthlyCents", () => {
    expect(() => createCompanySchema.parse({ name: "Acme", budgetMonthlyCents: 1.5 })).toThrow();
  });
});

describe("updateCompanySchema", () => {
  it("parses an empty object (all optional)", () => {
    const result = updateCompanySchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial updates", () => {
    const result = updateCompanySchema.parse({ name: "New Name" });
    expect(result.name).toBe("New Name");
  });

  it("accepts a valid brandColor", () => {
    const result = updateCompanySchema.parse({ brandColor: "#a1b2c3" });
    expect(result.brandColor).toBe("#a1b2c3");
  });

  it("rejects an invalid brandColor format", () => {
    expect(() => updateCompanySchema.parse({ brandColor: "red" })).toThrow();
    expect(() => updateCompanySchema.parse({ brandColor: "#xyz" })).toThrow();
  });

  it("rejects negative spentMonthlyCents", () => {
    expect(() => updateCompanySchema.parse({ spentMonthlyCents: -1 })).toThrow();
  });
});

describe("updateCompanyBrandingSchema", () => {
  it("parses when at least one field is provided", () => {
    const result = updateCompanyBrandingSchema.parse({ name: "Acme" });
    expect(result.name).toBe("Acme");
  });

  it("rejects when no field is provided", () => {
    expect(() => updateCompanyBrandingSchema.parse({})).toThrow(/at least one/i);
  });

  it("accepts a valid brandColor", () => {
    const result = updateCompanyBrandingSchema.parse({ brandColor: "#AABBCC" });
    expect(result.brandColor).toBe("#AABBCC");
  });

  it("rejects an invalid brandColor", () => {
    expect(() => updateCompanyBrandingSchema.parse({ brandColor: "#12345" })).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      updateCompanyBrandingSchema.parse({ name: "Acme", unknownField: "x" })
    ).toThrow();
  });
});

// ============================================================================
// project.ts
// ============================================================================

describe("createProjectWorkspaceSchema", () => {
  it("parses a local_path workspace with cwd", () => {
    const result = createProjectWorkspaceSchema.parse({ cwd: "/home/user/project" });
    expect(result.cwd).toBe("/home/user/project");
    expect(result.isPrimary).toBe(false);
  });

  it("parses a git_repo workspace with repoUrl", () => {
    const result = createProjectWorkspaceSchema.parse({
      sourceType: "git_repo",
      repoUrl: "https://github.com/acme/repo",
    });
    expect(result.sourceType).toBe("git_repo");
  });

  it("rejects when neither cwd nor repoUrl is provided for local types", () => {
    expect(() => createProjectWorkspaceSchema.parse({ name: "ws" })).toThrow(
      /cwd or repoUrl/i,
    );
  });

  it("parses a remote_managed workspace with remoteWorkspaceRef", () => {
    const result = createProjectWorkspaceSchema.parse({
      sourceType: "remote_managed",
      remoteWorkspaceRef: "ws-ref-123",
    });
    expect(result.sourceType).toBe("remote_managed");
  });

  it("rejects remote_managed workspace with neither remoteWorkspaceRef nor repoUrl", () => {
    expect(() =>
      createProjectWorkspaceSchema.parse({ sourceType: "remote_managed" })
    ).toThrow(/remoteWorkspaceRef or repoUrl/i);
  });

  it("defaults isPrimary to false", () => {
    const result = createProjectWorkspaceSchema.parse({ cwd: "/tmp" });
    expect(result.isPrimary).toBe(false);
  });
});

describe("updateProjectWorkspaceSchema", () => {
  it("parses an empty object (all partial)", () => {
    const result = updateProjectWorkspaceSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts partial workspace updates", () => {
    const result = updateProjectWorkspaceSchema.parse({ name: "new-name" });
    expect(result.name).toBe("new-name");
  });
});

describe("projectExecutionWorkspacePolicySchema", () => {
  it("parses with enabled=true", () => {
    const result = projectExecutionWorkspacePolicySchema.parse({ enabled: true });
    expect(result.enabled).toBe(true);
  });

  it("parses a full policy object", () => {
    const result = projectExecutionWorkspacePolicySchema.parse({
      enabled: true,
      defaultMode: "isolated_workspace",
      allowIssueOverride: true,
    });
    expect(result.defaultMode).toBe("isolated_workspace");
  });

  it("rejects invalid defaultMode", () => {
    expect(() =>
      projectExecutionWorkspacePolicySchema.parse({
        enabled: true,
        defaultMode: "invalid_mode",
      })
    ).toThrow();
  });

  it("rejects unknown fields (strict)", () => {
    expect(() =>
      projectExecutionWorkspacePolicySchema.parse({ enabled: true, unknownField: "x" })
    ).toThrow();
  });
});

describe("createProjectSchema", () => {
  it("parses a minimal project", () => {
    const result = createProjectSchema.parse({ name: "My Project" });
    expect(result.name).toBe("My Project");
    expect(result.status).toBe("backlog");
  });

  it("rejects empty name", () => {
    expect(() => createProjectSchema.parse({ name: "" })).toThrow();
  });

  it("accepts a workspace inline", () => {
    const result = createProjectSchema.parse({
      name: "p",
      workspace: { cwd: "/tmp" },
    });
    expect(result.workspace?.cwd).toBe("/tmp");
  });
});

describe("updateProjectSchema", () => {
  it("parses an empty object (all partial)", () => {
    const result = updateProjectSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts status update", () => {
    const result = updateProjectSchema.parse({ status: "in_progress" });
    expect(result.status).toBe("in_progress");
  });

  it("rejects invalid status", () => {
    expect(() => updateProjectSchema.parse({ status: "deleted" })).toThrow();
  });
});
