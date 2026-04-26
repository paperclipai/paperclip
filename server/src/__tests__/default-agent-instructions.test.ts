import { describe, it, expect } from "vitest";
import {
  resolveDefaultAgentInstructionsBundleRole,
  loadDefaultAgentInstructionsBundle,
} from "../services/default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("returns 'ceo' for role 'ceo'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("returns 'default' for any non-ceo role", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("manager")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("")).toBe("default");
  });

  it("is case-sensitive — 'CEO' is not the same as 'ceo'", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("CEO")).toBe("default");
  });
});

describe("loadDefaultAgentInstructionsBundle", () => {
  it("loads the default bundle containing AGENTS.md", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(bundle).toHaveProperty("AGENTS.md");
    expect(typeof bundle["AGENTS.md"]).toBe("string");
    expect(bundle["AGENTS.md"].length).toBeGreaterThan(0);
  });

  it("loads the ceo bundle containing all four files", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(bundle).toHaveProperty("AGENTS.md");
    expect(bundle).toHaveProperty("HEARTBEAT.md");
    expect(bundle).toHaveProperty("SOUL.md");
    expect(bundle).toHaveProperty("TOOLS.md");
    for (const content of Object.values(bundle)) {
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it("default bundle only contains AGENTS.md (not ceo files)", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("default");
    expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
  });
});
