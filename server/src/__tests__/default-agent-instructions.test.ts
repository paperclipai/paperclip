import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions bundle", () => {
  it("maps the ceo role to the ceo onboarding bundle", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
    expect(resolveDefaultAgentInstructionsBundleRole("engineer")).toBe("default");
  });

  it("includes charter-driven execution rules for CEO agents", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");

    expect(bundle["AGENTS.md"]).toContain("Project Charter Protocol");
    expect(bundle["AGENTS.md"]).toContain("Definition of Done");
    expect(bundle["HEARTBEAT.md"]).toContain("Project Charter Audit");
    expect(bundle["HEARTBEAT.md"]).toContain("Never self-assign unowned implementation work");
  });
});
