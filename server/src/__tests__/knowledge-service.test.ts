import { describe, expect, it } from "vitest";
import { buildKnowledgeSearchTerms, trimKnowledgeContent } from "../services/knowledge.js";

describe("knowledge service helpers", () => {
  it("collects unique search terms from issue context", () => {
    const terms = buildKnowledgeSearchTerms({
      title: "Adopt event-sourced billing ledger",
      description: "Use a ledger so budget calculations stay auditable.",
      project: { name: "Budget control plane" },
      goal: {
        id: "goal-1",
        companyId: "company-1",
        title: "Keep budget enforcement deterministic",
        description: null,
        level: "company",
        parentId: null,
        ownerAgentId: null,
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      ancestors: [
        {
          title: "Budget hard-stop policy",
          description: "Do not overspend after approval flows change.",
        },
      ],
    });

    expect(terms).toContain("ledger");
    expect(terms).toContain("budget");
    expect(terms).toContain("deterministic");
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("trims long content for heartbeat payloads", () => {
    const input = `${"A".repeat(20)} ${"B".repeat(20)}`;
    const trimmed = trimKnowledgeContent(input, 24);

    expect(trimmed.truncated).toBe(true);
    expect(trimmed.content.length).toBeLessThanOrEqual(24);
    expect(trimmed.content.endsWith("…")).toBe(true);
  });
});