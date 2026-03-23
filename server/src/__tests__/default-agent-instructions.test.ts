import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default-agent-instructions", () => {
  describe("resolveDefaultAgentInstructionsBundleRole", () => {
    it("returns 'ceo' for ceo role", () => {
      expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    });

    it("returns 'default' for non-ceo roles", () => {
      expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
      expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
      expect(resolveDefaultAgentInstructionsBundleRole("designer")).toBe("default");
    });
  });

  describe("loadDefaultAgentInstructionsBundle", () => {
    it("loads 4 files for ceo role", async () => {
      const bundle = await loadDefaultAgentInstructionsBundle("ceo");
      const keys = Object.keys(bundle).sort();
      expect(keys).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
      for (const key of keys) {
        expect(bundle[key].length).toBeGreaterThan(0);
      }
    });

    it("loads 4 files for default role", async () => {
      const bundle = await loadDefaultAgentInstructionsBundle("default");
      const keys = Object.keys(bundle).sort();
      expect(keys).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
      for (const key of keys) {
        expect(bundle[key].length).toBeGreaterThan(0);
      }
    });

    it("default AGENTS.md references HEARTBEAT.md, SOUL.md, and TOOLS.md", async () => {
      const bundle = await loadDefaultAgentInstructionsBundle("default");
      expect(bundle["AGENTS.md"]).toContain("HEARTBEAT.md");
      expect(bundle["AGENTS.md"]).toContain("SOUL.md");
      expect(bundle["AGENTS.md"]).toContain("TOOLS.md");
    });

    it("default and ceo bundles have different content", async () => {
      const defaultBundle = await loadDefaultAgentInstructionsBundle("default");
      const ceoBundle = await loadDefaultAgentInstructionsBundle("ceo");
      expect(defaultBundle["AGENTS.md"]).not.toBe(ceoBundle["AGENTS.md"]);
      expect(defaultBundle["HEARTBEAT.md"]).not.toBe(ceoBundle["HEARTBEAT.md"]);
      expect(defaultBundle["SOUL.md"]).not.toBe(ceoBundle["SOUL.md"]);
    });
  });
});
