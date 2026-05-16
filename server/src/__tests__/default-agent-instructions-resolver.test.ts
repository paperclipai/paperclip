import { describe, expect, it } from "vitest";
import { resolveDefaultAgentInstructionsBundleRole } from "../services/default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("resolves the ceo role to the ceo bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("resolves the worker role to the chief-local bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("worker")).toBe("chief-local");
  });

  it("resolves any other AGENT_ROLES value to the default bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("general")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cmo")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cfo")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("security")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("designer")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("pm")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("qa")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("devops")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("researcher")).toBe("default");
  });

  it("treats unknown role strings as the default bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("unknown-role")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
  });
});
