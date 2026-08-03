import { describe, expect, it } from "vitest";
import { agentConfigurationDoc, label, type } from "./index.js";

describe("jcode local adapter metadata", () => {
  it("uses the built-in local adapter type and human-facing label", () => {
    expect(type).toBe("jcode_local");
    expect(label).toBe("JCode");
    expect(agentConfigurationDoc).toContain("Adapter: jcode_local");
  });
});
