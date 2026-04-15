import { describe, expect, it } from "vitest";
import { loadDefaultAgentInstructionsBundle, resolveDefaultAgentInstructionsBundleRole } from "../services/default-agent-instructions.js";

describe("resolveDefaultAgentInstructionsBundleRole", () => {
  it("returns role-specific bundles for supported default roles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("coo")).toBe("coo");
    expect(resolveDefaultAgentInstructionsBundleRole("operations")).toBe("coo");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("engineer");
    expect(resolveDefaultAgentInstructionsBundleRole("qa")).toBe("qa");
  });

  it("falls back to the shared default bundle for other roles", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("cto")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("manager")).toBe("default");
  });
});

describe("loadDefaultAgentInstructionsBundle", () => {
  it("loads the role-specific AGENTS bundle content", async () => {
    const ceoBundle = await loadDefaultAgentInstructionsBundle("ceo");
    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const engineerBundle = await loadDefaultAgentInstructionsBundle("engineer");
    const qaBundle = await loadDefaultAgentInstructionsBundle("qa");
    const defaultBundle = await loadDefaultAgentInstructionsBundle("default");

    expect(ceoBundle["AGENTS.md"]).toContain("You are the CEO.");
    expect(ceoBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(cooBundle["AGENTS.md"]).toContain("Same-issue recovery is the default for stuck work.");
    expect(cooBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(engineerBundle["AGENTS.md"]).toContain("Never move a delivery issue from `In Progress` to `Done`.");
    expect(engineerBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(qaBundle["AGENTS.md"]).toContain("Only QA and Release Engineer moves a delivery issue from `In Review` to `Done`.");
    expect(qaBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(defaultBundle["AGENTS.md"]).toContain(
      "Successor issues linked by `recovered_by` are exceptional board-controlled recovery only.",
    );
    expect(defaultBundle["AGENTS.md"]).toContain("[POISONED SESSION]");
    expect(defaultBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
  });

  it("includes org baseline precedence and trivial-task fast path guidance", async () => {
    const ceoBundle = await loadDefaultAgentInstructionsBundle("ceo");
    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const engineerBundle = await loadDefaultAgentInstructionsBundle("engineer");
    const qaBundle = await loadDefaultAgentInstructionsBundle("qa");
    const defaultBundle = await loadDefaultAgentInstructionsBundle("default");

    const bundles = [ceoBundle, cooBundle, engineerBundle, qaBundle, defaultBundle];
    for (const bundle of bundles) {
      expect(bundle["AGENTS.md"]).toContain("Always apply the `org-engineering-baseline` skill for coding tasks.");
      expect(bundle["AGENTS.md"]).toContain("1. Direct user instructions");
      expect(bundle["AGENTS.md"]).toContain("2. Repo-local `AGENTS.md` and safety constraints");
      expect(bundle["AGENTS.md"]).toContain("3. `org-engineering-baseline`");
      expect(bundle["AGENTS.md"]).toContain(
        "Use the trivial-task fast path for obvious one-line or non-behavioral edits.",
      );
    }
  });
});
