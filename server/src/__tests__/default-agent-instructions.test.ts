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
    expect(cooBundle["AGENTS.md"]).toContain("A source issue linked by `recovered_by` may remain `blocked` as a valid recovery state.");
    expect(cooBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(engineerBundle["AGENTS.md"]).toContain("Never move a delivery issue from `In Progress` to `Done`.");
    expect(engineerBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(qaBundle["AGENTS.md"]).toContain("Only QA and Release Engineer moves a delivery issue from `In Review` to `Done`.");
    expect(qaBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
    expect(defaultBundle["AGENTS.md"]).toContain("[RECOVERED BY REISSUE]");
    expect(defaultBundle["ROLE_TEMPLATE.md"]).toContain("Default Agent Role Charter Baseline");
  });
});
