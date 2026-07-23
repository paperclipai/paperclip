import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./validators/agent.js";

function baseCreateInput(adapterConfig: Record<string, unknown>) {
  return {
    name: "Fallback Agent",
    adapterType: "codex_local",
    adapterConfig,
  };
}

describe("adapterConfig.fallback validation", () => {
  it("accepts an adapterConfig without a fallback block", () => {
    const parsed = createAgentSchema.safeParse(baseCreateInput({ model: "gpt-5" }));
    expect(parsed.success).toBe(true);
  });

  it("accepts a fully specified fallback block", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({
        fallback: {
          enabled: true,
          agentId: randomUUID(),
          on: ["provider_quota", "max_turns"],
          when: "retries_exhausted",
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("accepts a minimal fallback block (all keys optional)", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({ fallback: { enabled: true, agentId: randomUUID() } }),
    );
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown keys inside fallback", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({
        fallback: { enabled: true, agentId: randomUUID(), bogus: 1 },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-uuid agentId", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({ fallback: { enabled: true, agentId: "not-a-uuid" } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown trigger families in on", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({
        fallback: { enabled: true, agentId: randomUUID(), on: ["model_refusal"] },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown when value", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({
        fallback: { enabled: true, agentId: randomUUID(), when: "sometimes" },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-object fallback value", () => {
    const parsed = createAgentSchema.safeParse(baseCreateInput({ fallback: "yes" }));
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-boolean enabled flag", () => {
    const parsed = createAgentSchema.safeParse(
      baseCreateInput({ fallback: { enabled: "true", agentId: randomUUID() } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("applies the same validation on update", () => {
    const good = updateAgentSchema.safeParse({
      adapterConfig: { fallback: { enabled: true, agentId: randomUUID(), on: ["provider_quota"], when: "immediate" } },
    });
    expect(good.success).toBe(true);

    const bad = updateAgentSchema.safeParse({
      adapterConfig: { fallback: { on: "provider_quota" } },
    });
    expect(bad.success).toBe(false);
  });
});
