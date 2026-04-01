import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES, createAgentSchema } from "@paperclipai/shared";

describe("gemini_local shared adapter type coverage", () => {
  it("is present in shared AGENT_ADAPTER_TYPES", () => {
    expect(AGENT_ADAPTER_TYPES.includes("gemini_local")).toBe(true);
  });

  it("is accepted by createAgentSchema", () => {
    const parsed = createAgentSchema.parse({
      name: "Gemini Agent",
      adapterType: "gemini_local",
      adapterConfig: {},
    });

    expect(parsed.adapterType).toBe("gemini_local");
  });
});
