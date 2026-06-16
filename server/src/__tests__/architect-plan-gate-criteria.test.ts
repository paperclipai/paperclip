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
    // Slice only this section (up to the next criterion header) so the assertion
    // cannot pass vacuously from a later section that happens to say `blocking`.
    const start = content.indexOf("Projection source-of-truth");
    const end = content.indexOf("Scalability and bounds", start);
    const projSection = content.slice(start, end > start ? end : undefined);
    expect(projSection, "projection criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });

  it("scalability criterion marks unbounded query as blocking", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";
    const start = content.indexOf("Scalability and bounds");
    const end = content.indexOf("Test-harness wiring", start);
    const scalSection = content.slice(start, end > start ? end : undefined);
    expect(scalSection, "scalability criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });

  it("test-harness criterion marks trivially-passing test as blocking", async () => {
    const bundle = await loadDefaultAgentInstructionsBundle("architect");
    const content = bundle["AGENTS.md"] ?? "";
    const start = content.indexOf("Test-harness wiring");
    // Last section — slice to a known subsequent heading to avoid EOF ambiguity.
    const nextHeading = content.indexOf("\n## ", start);
    const testSection = content.slice(start, nextHeading > start ? nextHeading : undefined);
    expect(testSection, "test-harness criterion must mark concern as blocking").toContain(
      "`blocking`",
    );
  });
});
