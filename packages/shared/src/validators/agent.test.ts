import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  createAgentSchema,
  createAgentHireSchema,
  createAgentKeySchema,
  updateAgentSchema,
  updateAgentPermissionsSchema,
  wakeAgentSchema,
  agentMineInboxQuerySchema,
  resetAgentSessionSchema,
  updateAgentInstructionsBundleSchema,
  upsertAgentInstructionsFileSchema,
  updateAgentInstructionsPathSchema,
  testAdapterEnvironmentSchema,
} from "./agent.js";

describe("agentPermissionsSchema", () => {
  it("defaults canCreateAgents to false", () => {
    const result = agentPermissionsSchema.safeParse({});
    expect(result.success && result.data.canCreateAgents).toBe(false);
  });

  it("accepts explicit true", () => {
    const result = agentPermissionsSchema.safeParse({ canCreateAgents: true });
    expect(result.success && result.data.canCreateAgents).toBe(true);
  });
});

describe("createAgentSchema", () => {
  const minimal = { name: "my-agent", adapterType: "process" };

  it("accepts a minimal agent", () => {
    expect(createAgentSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createAgentSchema.safeParse({ ...minimal, name: "" }).success).toBe(false);
  });

  it("defaults role to general", () => {
    const result = createAgentSchema.safeParse(minimal);
    expect(result.success && result.data.role).toBe("general");
  });

  it("accepts valid role values", () => {
    for (const role of ["ceo", "cto", "engineer", "designer", "pm", "qa"]) {
      expect(createAgentSchema.safeParse({ ...minimal, role }).success).toBe(true);
    }
  });

  it("defaults budgetMonthlyCents to 0", () => {
    const result = createAgentSchema.safeParse(minimal);
    expect(result.success && result.data.budgetMonthlyCents).toBe(0);
  });

  it("rejects a negative budget", () => {
    expect(createAgentSchema.safeParse({ ...minimal, budgetMonthlyCents: -1 }).success).toBe(false);
  });

  it("defaults adapterConfig to empty object", () => {
    const result = createAgentSchema.safeParse(minimal);
    expect(result.success && result.data.adapterConfig).toEqual({});
  });

  it("accepts optional nullable fields", () => {
    const result = createAgentSchema.safeParse({
      ...minimal,
      title: "My Agent",
      reportsTo: "00000000-0000-0000-0000-000000000001",
      capabilities: "can code",
      metadata: { key: "value" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts adapterConfig with valid env bindings", () => {
    const result = createAgentSchema.safeParse({
      ...minimal,
      adapterConfig: {
        env: {
          API_KEY: { type: "plain", value: "sk-test" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects adapterConfig with invalid env bindings", () => {
    const result = createAgentSchema.safeParse({
      ...minimal,
      adapterConfig: {
        env: {
          API_KEY: { type: "bad_type", value: "sk-test" },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts desiredSkills as a string array", () => {
    const result = createAgentSchema.safeParse({
      ...minimal,
      desiredSkills: ["typescript", "react"],
    });
    expect(result.success).toBe(true);
  });
});

describe("createAgentHireSchema", () => {
  it("accepts minimal agent with sourceIssueId", () => {
    const result = createAgentHireSchema.safeParse({
      name: "hired",
      adapterType: "process",
      sourceIssueId: "00000000-0000-0000-0000-000000000001",
    });
    expect(result.success).toBe(true);
  });

  it("accepts sourceIssueIds array", () => {
    const result = createAgentHireSchema.safeParse({
      name: "hired",
      adapterType: "process",
      sourceIssueIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(result.success).toBe(true);
  });
});

describe("updateAgentSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateAgentSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a status update", () => {
    expect(updateAgentSchema.safeParse({ status: "paused" }).success).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(updateAgentSchema.safeParse({ status: "archived" }).success).toBe(false);
  });
});

describe("wakeAgentSchema", () => {
  it("defaults source to on_demand", () => {
    const result = wakeAgentSchema.safeParse({});
    expect(result.success && result.data.source).toBe("on_demand");
  });

  it("accepts valid source values", () => {
    for (const source of ["timer", "assignment", "on_demand", "automation"]) {
      expect(wakeAgentSchema.safeParse({ source }).success).toBe(true);
    }
  });

  it("rejects an invalid source", () => {
    expect(wakeAgentSchema.safeParse({ source: "webhook" }).success).toBe(false);
  });

  it("converts null forceFreshSession to false", () => {
    const result = wakeAgentSchema.safeParse({ forceFreshSession: null });
    expect(result.success && result.data.forceFreshSession).toBe(false);
  });

  it("defaults forceFreshSession to false", () => {
    const result = wakeAgentSchema.safeParse({});
    expect(result.success && result.data.forceFreshSession).toBe(false);
  });

  it("accepts optional payload and reason", () => {
    const result = wakeAgentSchema.safeParse({
      reason: "manual wake",
      payload: { key: "value" },
      idempotencyKey: "key-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts triggerDetail values", () => {
    for (const triggerDetail of ["manual", "ping", "callback", "system"]) {
      expect(wakeAgentSchema.safeParse({ triggerDetail }).success).toBe(true);
    }
  });
});

describe("agentMineInboxQuerySchema", () => {
  it("accepts a valid query", () => {
    const result = agentMineInboxQuerySchema.safeParse({ userId: "user-1" });
    expect(result.success).toBe(true);
  });

  it("rejects empty userId", () => {
    expect(agentMineInboxQuerySchema.safeParse({ userId: "" }).success).toBe(false);
  });

  it("defaults status to the INBOX_MINE filter", () => {
    const result = agentMineInboxQuerySchema.safeParse({ userId: "user-1" });
    expect(result.success && typeof result.data.status).toBe("string");
    expect(result.success && result.data.status!.length).toBeGreaterThan(0);
  });
});

describe("createAgentKeySchema", () => {
  it("defaults name to default", () => {
    const result = createAgentKeySchema.safeParse({});
    expect(result.success && result.data.name).toBe("default");
  });

  it("accepts a custom key name", () => {
    expect(createAgentKeySchema.safeParse({ name: "prod-key" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createAgentKeySchema.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("updateAgentPermissionsSchema", () => {
  it("accepts valid permissions", () => {
    const result = updateAgentPermissionsSchema.safeParse({
      canCreateAgents: true,
      canAssignTasks: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing canAssignTasks", () => {
    expect(updateAgentPermissionsSchema.safeParse({ canCreateAgents: true }).success).toBe(false);
  });
});

describe("resetAgentSessionSchema", () => {
  it("accepts an empty object", () => {
    expect(resetAgentSessionSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a taskKey", () => {
    expect(resetAgentSessionSchema.safeParse({ taskKey: "task-1" }).success).toBe(true);
  });

  it("accepts null taskKey", () => {
    expect(resetAgentSessionSchema.safeParse({ taskKey: null }).success).toBe(true);
  });
});

describe("updateAgentInstructionsBundleSchema", () => {
  it("accepts an empty object", () => {
    expect(updateAgentInstructionsBundleSchema.safeParse({}).success).toBe(true);
  });

  it("accepts mode managed", () => {
    expect(updateAgentInstructionsBundleSchema.safeParse({ mode: "managed" }).success).toBe(true);
  });

  it("rejects an invalid mode", () => {
    expect(updateAgentInstructionsBundleSchema.safeParse({ mode: "auto" }).success).toBe(false);
  });

  it("defaults clearLegacyPromptTemplate to false", () => {
    const result = updateAgentInstructionsBundleSchema.safeParse({});
    expect(result.success && result.data.clearLegacyPromptTemplate).toBe(false);
  });
});

describe("upsertAgentInstructionsFileSchema", () => {
  it("accepts a valid file upsert", () => {
    const result = upsertAgentInstructionsFileSchema.safeParse({
      path: "/prompts/agent.md",
      content: "# Instructions\n",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty path", () => {
    expect(upsertAgentInstructionsFileSchema.safeParse({ path: "", content: "x" }).success).toBe(false);
  });
});

describe("updateAgentInstructionsPathSchema", () => {
  it("accepts a valid path", () => {
    expect(updateAgentInstructionsPathSchema.safeParse({ path: "/prompts/agent.md" }).success).toBe(true);
  });

  it("accepts null path (clear)", () => {
    expect(updateAgentInstructionsPathSchema.safeParse({ path: null }).success).toBe(true);
  });
});

describe("testAdapterEnvironmentSchema", () => {
  it("accepts an empty object (defaults)", () => {
    expect(testAdapterEnvironmentSchema.safeParse({}).success).toBe(true);
  });

  it("accepts adapterConfig with env", () => {
    const result = testAdapterEnvironmentSchema.safeParse({
      adapterConfig: { env: { KEY: "value" } },
    });
    expect(result.success).toBe(true);
  });
});
