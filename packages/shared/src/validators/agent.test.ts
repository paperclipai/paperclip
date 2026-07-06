import { describe, expect, it } from "vitest";
import {
  createAgentSchema,
  createAgentHireSchema,
  updateAgentSchema,
} from "./agent.js";

describe("createAgentSchema", () => {
  const validBase = {
    name: "TestAgent",
    adapterType: "codex_local",
  };

  it("accepts agent with sovereign model", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "sovereign-deepseek-coder-v3" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts agent with souverain model (French variant)", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "souverain-qwen3-coder" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts agent without model field (no model = OK, server decides)", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts agent with empty string model (treated as unset)", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "" },
    });
    // Empty string after trim is falsy, so sovereign check skips
    expect(parsed.success).toBe(true);
  });

  it("rejects agent with non-sovereign model", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "gpt-4o" },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const modelIssue = parsed.error.issues.find((i) =>
        i.path.includes("model"),
      );
      expect(modelIssue).toBeDefined();
      expect(modelIssue!.message).toContain("sovereign");
    }
  });

  it("rejects agent with cloud model name", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "claude-sonnet-4-6" },
    });
    expect(parsed.success).toBe(false);
  });

  it("sovereign check is case-insensitive", () => {
    const parsed = createAgentSchema.safeParse({
      ...validBase,
      adapterConfig: { model: "SOVEREIGN-DeepSeek-V3" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts agent with default adapterConfig (no model)", () => {
    const parsed = createAgentSchema.safeParse(validBase);
    expect(parsed.success).toBe(true);
  });
});

describe("createAgentHireSchema", () => {
  it("rejects hire with non-sovereign model", () => {
    const parsed = createAgentHireSchema.safeParse({
      name: "HiredAgent",
      adapterType: "claude_local",
      adapterConfig: { model: "claude-opus-4-7" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts hire with sovereign model", () => {
    const parsed = createAgentHireSchema.safeParse({
      name: "HiredAgent",
      adapterType: "claude_local",
      adapterConfig: { model: "sovereign-claude-opus" },
      sourceIssueId: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("updateAgentSchema", () => {
  it("rejects update with non-sovereign model", () => {
    const parsed = updateAgentSchema.safeParse({
      adapterConfig: { model: "gpt-4-turbo" },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts update with sovereign model", () => {
    const parsed = updateAgentSchema.safeParse({
      adapterConfig: { model: "sovereign-qwen3-235b" },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts update without model change", () => {
    const parsed = updateAgentSchema.safeParse({
      name: "RenamedAgent",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("runtimeConfig model profiles sovereign check", () => {
  it("rejects non-sovereign model in cheap profile", () => {
    const parsed = createAgentSchema.safeParse({
      name: "ProfileAgent",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "gpt-4o-mini" },
          },
        },
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts sovereign model in cheap profile", () => {
    const parsed = createAgentSchema.safeParse({
      name: "ProfileAgent",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "sovereign-codex-spark" },
          },
        },
      },
    });
    expect(parsed.success).toBe(true);
  });
});
