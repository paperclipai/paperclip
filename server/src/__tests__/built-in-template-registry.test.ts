import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getBuiltInTemplate,
  listBuiltInTemplates,
  loadBuiltInTemplateBundle,
} from "../templates/registry.js";

const templatesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates",
);

describe("built-in template registry", () => {
  it("lists bundled templates", async () => {
    const templates = await listBuiltInTemplates({ templatesRoot });
    expect(templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "solo-founder-lite",
          name: "Solo Founder Lite",
          agentCount: 2,
          companyName: "Solo Founder Lite",
        }),
        expect.objectContaining({
          id: "safe-autonomous-organization",
          name: "Safe Autonomous Organization",
          maturity: "opinionated",
          riskProfile: "high-control",
          agentCount: 6,
          companyName: "Safe Autonomous Organization",
        }),
      ]),
    );
  });

  it("loads built-in template detail", async () => {
    const detail = await getBuiltInTemplate("solo-founder-lite", { templatesRoot });
    expect(detail.id).toBe("solo-founder-lite");
    expect(detail.manifest.agents.map((agent) => agent.slug)).toEqual(["ceo", "operator"]);
    expect(detail.setupMarkdown).toBeNull();
  });

  it("loads safe autonomous organization detail", async () => {
    const detail = await getBuiltInTemplate("safe-autonomous-organization", { templatesRoot });
    expect(detail.id).toBe("safe-autonomous-organization");
    expect(detail.manifest.agents.map((agent) => agent.slug)).toEqual([
      "ceo",
      "safety-lead",
      "operations-lead",
      "research-lead",
      "finance-risk-lead",
      "operator",
    ]);
    expect(detail.useCases).toEqual([
      "governance-first automation",
      "high-trust operations",
    ]);
    expect(detail.recommendedFor).toEqual([
      "regulated workflows",
      "governance-first operators",
    ]);
    expect(detail.manifest.issues).toHaveLength(4);
    expect(detail.manifest.agents[0]).toEqual(expect.objectContaining({
      slug: "ceo",
      budgetMonthlyCents: 15000,
      adapterConfig: expect.objectContaining({
        dangerouslyBypassApprovalsAndSandbox: false,
        modelReasoningEffort: "high",
      }),
    }));
    expect(detail.setupMarkdown).toContain("Safe Autonomous Organization Setup");
  });

  it("loads the full built-in template bundle", async () => {
    const bundle = await loadBuiltInTemplateBundle("solo-founder-lite", { templatesRoot });
    expect(bundle.manifest.company?.path).toBe("COMPANY.md");
    expect(bundle.files["COMPANY.md"]).toContain("Solo Founder Lite");
    expect(bundle.files["agents/ceo/AGENTS.md"]).toContain("You are the chief executive");
  });
});
