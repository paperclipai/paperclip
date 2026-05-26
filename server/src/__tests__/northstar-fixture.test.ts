import { describe, expect, it } from "vitest";
import { NORTHSTAR_EXPECTED_FINDINGS, buildNorthstarFixturePlan } from "../services/weekly-review/northstar-fixture.js";

describe("Northstar weekly review fixture", () => {
  it("defines the locked eight findings in PRD order", () => {
    expect(NORTHSTAR_EXPECTED_FINDINGS).toEqual([
      {
        stableId: "NSR-F01",
        category: "decision_blocker",
        severity: "critical",
        workstream: "Operations",
        title: "Support handoff owner missing blocks broad rollout",
      },
      {
        stableId: "NSR-F02",
        category: "action_required",
        severity: "high",
        workstream: "Governance",
        title: "Approve limited pilot rollout",
      },
      {
        stableId: "NSR-F03",
        category: "action_required",
        severity: "high",
        workstream: "Operations",
        title: "Assign Support/Ops Lead owner",
      },
      {
        stableId: "NSR-F04",
        category: "evidence_gap",
        severity: "high",
        workstream: "Research & Insights",
        title: "Research brief has one unsupported customer-segment claim",
      },
      {
        stableId: "NSR-F05",
        category: "stale_item",
        severity: "medium",
        workstream: "Operations",
        title: "Operations runbook update is stale and still blocks support handoff",
      },
      {
        stableId: "NSR-F06",
        category: "budget_signal",
        severity: "medium",
        workstream: "Budget",
        title: "Budget warning from citation-validation retries and prototype implementation spend",
      },
      {
        stableId: "NSR-F07",
        category: "quality_signal",
        severity: "medium",
        workstream: "Research & Insights",
        title: "Research summarization run failed validation",
      },
      {
        stableId: "NSR-F08",
        category: "win_context",
        severity: "low",
        workstream: "Product Delivery",
        title: "Cited weekly inbox digest prototype is ready for limited pilot",
      },
    ]);
  });

  it("builds the Northstar company fixture with six agents and expected findings", () => {
    const plan = buildNorthstarFixturePlan();

    expect(plan.company).toMatchObject({
      name: "Northstar Labs",
      issuePrefix: "NSR",
    });
    expect(plan.agents).toHaveLength(6);
    expect(plan.expectedFindings).toEqual(NORTHSTAR_EXPECTED_FINDINGS);
    expect(plan.expectedFindings).not.toBe(NORTHSTAR_EXPECTED_FINDINGS);
  });

  it("assigns local adapters and model policies by role", () => {
    const plan = buildNorthstarFixturePlan();

    expect(plan.agents.find((agent) => agent.key === "engineering-lead")).toMatchObject({
      name: "Engineering Lead",
      adapterType: "codex_local",
      workstream: "Product Delivery",
      modelPolicy: {
        selectedProfile: "primary",
      },
    });
    expect(plan.agents.find((agent) => agent.key === "research-insights-lead")).toMatchObject({
      name: "Research & Insights Lead",
      adapterType: "agy_local",
      workstream: "Research & Insights",
      modelPolicy: {
        selectedModel: "gemini-3.5-flash",
        requiredModel: "gemini-3.5-flash",
        selectedProfile: "primary",
        assuranceSource: "desired_fixture_policy",
      },
    });
    expect(plan.agents.find((agent) => agent.key === "ceo")).toMatchObject({
      name: "CEO",
      adapterType: "claude_local",
      workstream: "Governance",
      modelPolicy: {
        selectedProfile: "primary",
      },
    });
  });

  it("does not seed legacy gemini_local agents", () => {
    const plan = buildNorthstarFixturePlan();

    expect(plan.agents.map((agent) => agent.adapterType)).not.toContain("gemini_local");
  });

  it("protects locked expected findings from caller mutation", () => {
    const plan = buildNorthstarFixturePlan();

    plan.expectedFindings[0].stableId = "NSR-F08";

    expect(buildNorthstarFixturePlan().expectedFindings[0].stableId).toBe("NSR-F01");
    expect(NORTHSTAR_EXPECTED_FINDINGS[0].stableId).toBe("NSR-F01");
    expect(Object.isFrozen(NORTHSTAR_EXPECTED_FINDINGS)).toBe(true);
    expect(Object.isFrozen(NORTHSTAR_EXPECTED_FINDINGS[0])).toBe(true);
  });
});
