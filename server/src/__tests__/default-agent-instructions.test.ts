import { describe, expect, it } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.ts";

describe("default CEO onboarding assets", () => {
  it("prefer inbox-lite and avoid proactive preview routes on the shared workflow", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("ceo");

    expect(bundle["AGENTS.md"]).toContain("inbox-lite");
    expect(bundle["HEARTBEAT.md"]).toContain("GET /api/companies/{companyId}/dashboard");
    expect(bundle["HEARTBEAT.md"]).toContain("GET /api/agents/me/inbox-lite");
    expect(bundle["HEARTBEAT.md"]).toContain("GET /api/issues/{issueId}/heartbeat-context");
    expect(bundle["AGENTS.md"]).not.toContain("proactive-project-loop/preview");
    expect(bundle["HEARTBEAT.md"]).not.toContain("proactive-project-loop/preview");
  });
});
