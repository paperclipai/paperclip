import { describe, expect, it } from "vitest";
import { loadDefaultAgentInstructionsBundle } from "../services/default-agent-instructions.js";

describe("architect plan-gate criteria — B4 adversarial checks", () => {
  it("onboarding-assets architect AGENTS.md contains all three adversarial gate criteria", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";

    expect(content, "missing projection source-of-truth check").toContain(
      "Projection source-of-truth",
    );
    expect(content, "missing scalability/bounds check").toContain(
      "Scalability and bounds",
    );
    expect(content, "missing test-harness wiring check").toContain(
      "Test-harness wiring",
    );
  });

  it("projection criterion marks wrong-source field as blocking", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";
    // The criteria must explicitly label the concern as blocking so the gate fires.
    const projSection = content.slice(content.indexOf("Projection source-of-truth"));
    expect(projSection, "projection criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });

  it("scalability criterion marks unbounded query as blocking", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";
    const scalSection = content.slice(content.indexOf("Scalability and bounds"));
    expect(scalSection, "scalability criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });

  it("test-harness criterion marks trivially-passing test as blocking", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";
    const testSection = content.slice(content.indexOf("Test-harness wiring"));
    expect(testSection, "test-harness criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });
});
