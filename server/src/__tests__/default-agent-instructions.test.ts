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
    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const engineerBundle = await loadDefaultAgentInstructionsBundle("engineer");
    const qaBundle = await loadDefaultAgentInstructionsBundle("qa");
    const defaultBundle = await loadDefaultAgentInstructionsBundle("default");

    expect(cooBundle["AGENTS.md"]).toContain("valid `recovered_by` successor is healthy recovery state");
    expect(engineerBundle["AGENTS.md"]).toContain("Never move a delivery issue from `In Progress` to `Done`.");
    expect(qaBundle["AGENTS.md"]).toContain("Only QA and Release Engineer moves a delivery issue from `In Review` to `Done`.");
    expect(defaultBundle["AGENTS.md"]).toContain("[RECOVERED BY REISSUE]");
  });
});
