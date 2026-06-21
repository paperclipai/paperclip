import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./agent.js";

describe("agent validators", () => {
  const baseAgent = {
    name: "test-agent",
    adapterType: "claude_local" as const,
  };

  it("rejects adapterConfig.env with PAPERCLIP_-prefixed keys", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: { env: { PAPERCLIP_FOO: "bar" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues[0].message;
      expect(msg).toContain("reserved PAPERCLIP_ prefix");
    }
  });

  it("rejects adapterConfig.env with multiple PAPERCLIP_-prefixed keys", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: { env: { PAPERCLIP_A: "1", PAPERCLIP_B: "2" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(1);
      const msg = result.error.issues[0].message;
      expect(msg).toContain("reserved PAPERCLIP_ prefix");
    }
  });

  it("accepts adapterConfig.env with normal keys", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: { env: { OPENAI_API_KEY: "sk-1234", DATABASE_URL: "postgres://localhost/db" } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts adapterConfig.env with mixed normal and PAPERCLIP_ keys (rejects)", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: {
        env: { OPENAI_API_KEY: "sk-1234", PAPERCLIP_FORBIDDEN: "should-fail" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts adapterConfig with no env field", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts adapterConfig with empty env object", () => {
    const result = createAgentSchema.safeParse({
      ...baseAgent,
      adapterConfig: { env: {} },
    });
    expect(result.success).toBe(true);
  });
});
