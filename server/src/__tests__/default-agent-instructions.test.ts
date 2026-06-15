import { describe, expect, it } from "vitest";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole — identity-aware seed selection", () => {
  it("routes gate agents by derived urlKey despite a generic role", () => {
    // Gate agents carry generic roles (architect/wiring → "engineer",
    // code-reviewer → "qa") but a distinct identity in their name.
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "architect")).toBe("architect");
    expect(resolveDefaultAgentInstructionsBundleRole("qa", "code-reviewer")).toBe("code-reviewer");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "wiring-expert")).toBe("wiring-expert");
  });

  it("derives the gate urlKey from the agent name the same way the create path does", () => {
    expect(
      resolveDefaultAgentInstructionsBundleRole("engineer", normalizeAgentUrlKey("Architect")),
    ).toBe("architect");
    expect(
      resolveDefaultAgentInstructionsBundleRole("qa", normalizeAgentUrlKey("Code Reviewer")),
    ).toBe("code-reviewer");
    expect(
      resolveDefaultAgentInstructionsBundleRole("engineer", normalizeAgentUrlKey("Wiring Expert")),
    ).toBe("wiring-expert");
  });

  it("keeps ceo role-driven", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("ceo", "ceo")).toBe("ceo");
    // An engineer merely named "CEO" must NOT seed the ceo bundle via urlKey.
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "ceo")).toBe("default");
  });

  it("routes cto role to cto bundle regardless of urlKey", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("cto");
    expect(resolveDefaultAgentInstructionsBundleRole("cto", "cto")).toBe("cto");
    expect(resolveDefaultAgentInstructionsBundleRole("cto", null)).toBe("cto");
    // An engineer named "CTO" must NOT get the cto bundle — role check wins.
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "cto")).toBe("default");
  });

  it("falls back to default for ordinary identities and missing urlKey", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", undefined)).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", null)).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "backend")).toBe("default");
    // "default" is not urlKey-routable — no hijack.
    expect(resolveDefaultAgentInstructionsBundleRole("engineer", "default")).toBe("default");
  });
});

describe("loadDefaultAgentInstructionsBundle — gate-role seed bundles exist and are W1-safe", () => {
  it.each(["cto", "architect", "code-reviewer", "wiring-expert"] as const)(
    "ships a non-empty AGENTS.md for %s",
    async (role) => {
      const bundle = await loadDefaultAgentInstructionsBundle(role);
      expect(Object.keys(bundle)).toEqual(["AGENTS.md"]);
      // Non-empty entry file => isManagedBundleEmpty() is false after materialize,
      // so the W1 readiness gate never pauses a freshly-seeded gate agent.
      expect(bundle["AGENTS.md"].trim().length).toBeGreaterThan(0);
    },
  );
});
