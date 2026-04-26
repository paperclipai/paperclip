import { describe, expect, it } from "vitest";
import { resolveDefaultAgentInstructionsBundleRole } from "./default-agent-instructions.js";

// ============================================================================
// resolveDefaultAgentInstructionsBundleRole
// ============================================================================

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("returns 'ceo' for role 'ceo'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("returns 'default' for role 'cto'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
  });

  it("returns 'default' for role 'engineer'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
  });

  it("returns 'default' for empty string", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
  });

  it("returns 'default' for unknown role", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("contractor")).toBe("default");
  });

  it("is case-sensitive — 'CEO' does not map to ceo bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("CEO")).toBe("default");
  });
});
