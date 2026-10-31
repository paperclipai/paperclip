import { describe, expect, it } from "vitest";
import type { BudgetOverview, CostByAgent, CostByAgentModel } from "@paperclipai/shared";
import { agentBudgetSummary } from "./AgentBudgetsPanel";
import { agentCostRow, agentModelCostRows } from "./AgentCostsPanel";

const agent = {
  id: "agent-1",
  name: "Atlas",
  status: "active",
  pauseReason: null,
  budgetMonthlyCents: 10_000,
  spentMonthlyCents: 2_500,
} as const;

function costRow(agentId: string | null, costCents: number): CostByAgent {
  return {
    agentId,
    agentName: agentId,
    agentStatus: "active",
    eventCount: 1,
    estimatedEventCount: 0,
    costCents,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    apiRunCount: 1,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
  };
}

function modelRow(agentId: string, model: string, costCents: number): CostByAgentModel {
  return {
    agentId,
    agentName: agentId,
    provider: "anthropic",
    biller: "anthropic",
    billingType: "metered_api",
    model,
    eventCount: 1,
    estimatedEventCount: 0,
    costCents,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
  };
}

describe("agent-scoped audit data", () => {
  it("keeps only the agent's cost row and orders its models by spend", () => {
    expect(agentCostRow([costRow("agent-2", 900), costRow("agent-1", 300), costRow(null, 50)], "agent-1")?.costCents).toBe(300);
    expect(agentCostRow([costRow("agent-2", 900)], "agent-1")).toBeNull();
    expect(
      agentModelCostRows([modelRow("agent-1", "small", 20), modelRow("agent-2", "other", 90), modelRow("agent-1", "large", 80)], "agent-1").map((row) => row.model),
    ).toEqual(["large", "small"]);
  });

  it("uses the agent's own budget policy and falls back to its monthly budget", () => {
    const policy = { ...agentBudgetSummary(undefined, agent, "company-1"), policyId: "policy-1", amount: 50_000 };
    const overview = {
      companyId: "company-1",
      policies: [{ ...policy, scopeId: "agent-2", policyId: "policy-2" }, policy],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    } satisfies BudgetOverview;
    expect(agentBudgetSummary(overview, agent, "company-1").policyId).toBe("policy-1");

    const fallback = agentBudgetSummary(undefined, agent, "company-1");
    expect(fallback.scopeType).toBe("agent");
    expect(fallback.amount).toBe(10_000);
    expect(fallback.remainingAmount).toBe(7_500);
    expect(fallback.utilizationPercent).toBe(25);
    expect(fallback.status).toBe("ok");
  });
});
