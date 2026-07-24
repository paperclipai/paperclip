import { describe, expect, it } from "vitest";
import { classifySkillRisk } from "../services/company-skill-risk-classifier.js";

describe("classifySkillRisk", () => {
  it("classifies a skill that touches pricing/invoicing as Tier 2 (money-tool touch)", () => {
    const result = classifySkillRisk({
      markdown: [
        "---",
        "name: Send Customer Invoice",
        "---",
        "# Send Customer Invoice",
        "",
        "This skill calculates the final pricing, applies the customer's margin, and submits payment via the billing API to dispatch the invoice.",
      ].join("\n"),
      metadata: null,
      fileInventory: [],
      categories: [],
    });

    expect(result.tier).toBe(2);
    expect(result.rationale.matchedRule).toBe("money_tool_touch");
    expect(result.rationale.matchedSignals.length).toBeGreaterThan(0);
  });

  it("classifies a skill that only writes a local record as Tier 1 (write-scope, no money terms)", () => {
    const result = classifySkillRisk({
      markdown: [
        "# Log Meeting Notes",
        "",
        "This skill writes a new markdown record to the notes folder and updates the index file.",
      ].join("\n"),
      metadata: null,
      fileInventory: [{ path: "notes/index.md", kind: "reference" }],
      categories: [],
    });

    expect(result.tier).toBe(1);
    expect(result.rationale.matchedRule).toBe("write_scope");
  });

  it("classifies a read-only lookup/summary skill as Tier 0", () => {
    const result = classifySkillRisk({
      markdown: [
        "# Summarize PR",
        "",
        "This skill reads a pull request and produces a formatted summary of the changes for the reader.",
      ].join("\n"),
      metadata: null,
      fileInventory: [],
      categories: [],
    });

    expect(result.tier).toBe(0);
    expect(result.rationale.matchedRule).toBe("read_only_default");
  });

  it("money-tool touch always wins over write-scope signals in the same skill", () => {
    const result = classifySkillRisk({
      markdown: "This skill writes an updated invoice record and submits the payment.",
      metadata: null,
      fileInventory: [],
      categories: [],
    });

    expect(result.tier).toBe(2);
    expect(result.rationale.matchedRule).toBe("money_tool_touch");
  });
});
