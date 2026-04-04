import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { companyPortabilityService } from "../services/company-portability.js";

const templatesRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../templates",
);

describe("company portability built-in source", () => {
  it("previews a built-in template import via the existing portability path", async () => {
    const portability = companyPortabilityService({} as any, { templatesRoot });

    const preview = await portability.previewImport({
      source: {
        type: "builtin",
        templateId: "solo-founder-lite",
      },
      target: {
        mode: "new_company",
        newCompanyName: null,
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(preview.plan.companyAction).toBe("create");
    expect(preview.selectedAgentSlugs).toEqual(["ceo", "operator"]);
    expect(preview.plan.agentPlans).toEqual([
      expect.objectContaining({ slug: "ceo", action: "create", plannedName: "CEO" }),
      expect.objectContaining({ slug: "operator", action: "create", plannedName: "Operator" }),
    ]);
  });

  it("previews the safe autonomous organization template", async () => {
    const portability = companyPortabilityService({} as any, { templatesRoot });

    const preview = await portability.previewImport({
      source: {
        type: "builtin",
        templateId: "safe-autonomous-organization",
      },
      include: {
        company: true,
        agents: true,
        goals: true,
        projects: true,
        issues: true,
      },
      target: {
        mode: "new_company",
        newCompanyName: null,
      },
      agents: "all",
      collisionStrategy: "rename",
    });

    expect(preview.errors).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(preview.plan.companyAction).toBe("create");
    expect(preview.selectedAgentSlugs).toEqual([
      "ceo",
      "safety-lead",
      "operations-lead",
      "research-lead",
      "finance-risk-lead",
      "operator",
    ]);
    expect(preview.plan.goalPlans).toHaveLength(3);
    expect(preview.plan.projectPlans).toHaveLength(2);
    expect(preview.plan.issuePlans).toHaveLength(4);
  });
});
