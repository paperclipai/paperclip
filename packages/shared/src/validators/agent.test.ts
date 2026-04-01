import { describe, expect, it } from "vitest";
import { createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agent schemas", () => {
  it("accepts gemini_local as an adapter type", () => {
    const createResult = createAgentSchema.safeParse({
      name: "Gemini Agent",
      adapterType: "gemini_local",
    });
    const updateResult = updateAgentSchema.safeParse({
      adapterType: "gemini_local",
    });

    expect(createResult.success).toBe(true);
    expect(updateResult.success).toBe(true);
  });
});
