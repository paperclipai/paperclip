import { describe, expect, it } from "vitest";
import { classifySkillRisk } from "../services/company-skill-risk-classifier.js";

describe("classifySkillRisk", () => {
  it("classifies a skill that touches pricing/invoicing as Tier 2 (money-tool touch)", () => {
    const result = classifySkillRisk({ markdown: "This skill calculates pricing and submits payment via billing.", metadata: null, fileInventory: [], categories: [] });
    expect(result.tier).toBe(2);
    expect(result.rationale.matchedRule).toBe("money_tool_touch");
  });

  it("classifies a skill that writes a local record as Tier 1", () => {
    const result = classifySkillRisk({ markdown: "This skill writes a new markdown record.", metadata: null, fileInventory: [{ path: "notes/index.md" }], categories: [] });
    expect(result.tier).toBe(1);
    expect(result.rationale.matchedRule).toBe("write_scope");
  });

  it("classifies a read-only lookup/summary skill as Tier 0", () => {
    const result = classifySkillRisk({ markdown: "This skill reads a pull request and produces a summary.", metadata: null, fileInventory: [], categories: [] });
    expect(result.tier).toBe(0);
    expect(result.rationale.matchedRule).toBe("read_only_default");
  });

  it("gives money-tool signals precedence over write-scope signals", () => {
    const result = classifySkillRisk({ markdown: "This skill writes an invoice record and submits payment.", metadata: null, fileInventory: [], categories: [] });
    expect(result.tier).toBe(2);
    expect(result.rationale.matchedRule).toBe("money_tool_touch");
  });
});
