import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions", () => {
  it("uses the CEO bundle for company-mode root agents", async () => {
    expect(
      resolveDefaultAgentInstructionsBundleRole({
        role: "ceo",
        organizationMode: "company",
      }),
    ).toBe("ceo");

    const bundle = await loadDefaultAgentInstructionsBundle("ceo");
    expect(bundle["AGENTS.md"]).toContain("You are the CEO.");
    expect(bundle["AGENTS.md"]).toContain("technical tasks** → CTO");
  });

  it("uses the team lead bundle for team-mode root agents", async () => {
    expect(
      resolveDefaultAgentInstructionsBundleRole({
        role: "ceo",
        organizationMode: "team",
      }),
    ).toBe("ceo_team");

    const bundle = await loadDefaultAgentInstructionsBundle("ceo_team");
    expect(bundle["AGENTS.md"]).toContain("You are the Team Lead.");
    expect(bundle["AGENTS.md"]).toContain("technical tasks** → Founding Engineer");
    expect(bundle["HEARTBEAT.md"]).toContain("Team Lead Heartbeat Checklist");
  });
});
