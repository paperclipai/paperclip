import { describe, expect, it } from "vitest";
import { AGENT_ADAPTER_TYPES } from "./constants.js";
import { createAgentSchema } from "./validators/agent.js";

describe("shared adapter registration", () => {
  it("includes hermes_local and hermes_gateway in the allowed agent adapter types", () => {
    expect(AGENT_ADAPTER_TYPES).toContain("hermes_local");
    expect(AGENT_ADAPTER_TYPES).toContain("hermes_gateway");
  });

  it("accepts hermes_local and hermes_gateway when validating agent creation payloads", () => {
    const localParsed = createAgentSchema.parse({
      name: "Hermes Local",
      adapterType: "hermes_local",
    });
    const gatewayParsed = createAgentSchema.parse({
      name: "Hermes Gateway",
      adapterType: "hermes_gateway",
    });

    expect(localParsed.adapterType).toBe("hermes_local");
    expect(gatewayParsed.adapterType).toBe("hermes_gateway");
  });
});
