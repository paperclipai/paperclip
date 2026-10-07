import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CostByAgent, CostByAgentModel, CostByBiller, CostByProject, CostByProviderModel, CostByUserReport } from "@paperclipai/shared";
import { Costs } from "@/pages/Costs";
import { useCompany } from "@/context/CompanyContext";

const companyId = "company-storybook";
const base = {
  agentStatus: "idle", inputTokens: 240_000, cachedInputTokens: 2_400_000,
  outputTokens: 40_000, subscriptionRunCount: 0,
  subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0,
};
const agents: CostByAgent[] = [
  { ...base, agentId: "bender", agentName: "Bender", costCents: 40288, inputTokens: 8_644_366, cachedInputTokens: 253_466_296, outputTokens: 2_008_119, apiRunCount: 72, eventCount: 72, estimatedEventCount: 0 },
  { ...base, agentId: "codie", agentName: "Codie", costCents: 1234, apiRunCount: 6, eventCount: 6, estimatedEventCount: 6 },
  { ...base, agentId: "fry", agentName: "Fry", costCents: 823, apiRunCount: 7, eventCount: 7, estimatedEventCount: 4 },
  { ...base, agentId: "leela", agentName: "Leela", costCents: 0, apiRunCount: 0, subscriptionRunCount: 11, eventCount: 11, estimatedEventCount: 0,
    subscriptionInputTokens: base.inputTokens, subscriptionCachedInputTokens: base.cachedInputTokens, subscriptionOutputTokens: base.outputTokens },
];
const projects: CostByProject[] = [
  { projectId: "project-orchestration", projectName: "Agent orchestration", members: [agents[0]] },
  { projectId: "project-cost-reporting", projectName: "Cost reporting", members: [agents[1], agents[2]] },
  { projectId: "project-research", projectName: "Research", members: [agents[3]] },
].map(({ projectId, projectName, members }) => ({
  projectId,
  projectName,
  costCents: members.reduce((sum, agent) => sum + agent.costCents, 0),
  inputTokens: members.reduce((sum, agent) => sum + agent.inputTokens, 0),
  cachedInputTokens: members.reduce((sum, agent) => sum + agent.cachedInputTokens, 0),
  outputTokens: members.reduce((sum, agent) => sum + agent.outputTokens, 0),
}));
const users: CostByUserReport = {
  activeUserCount: 2,
  rows: [
    { userId: "alice", userName: "Alice", members: [agents[0], agents[3]] },
    { userId: "bob", userName: "Bob", members: [agents[1], agents[2]] },
  ].map(({ userId, userName, members }) => ({
    userId, userName, userImage: null, unpricedEventCount: 0,
    costCents: members.reduce((sum, agent) => sum + agent.costCents, 0),
    costCentsExact: members.reduce((sum, agent) => sum + agent.costCents, 0).toFixed(7),
    inputTokens: members.reduce((sum, agent) => sum + agent.inputTokens, 0),
    cachedInputTokens: members.reduce((sum, agent) => sum + agent.cachedInputTokens, 0),
    outputTokens: members.reduce((sum, agent) => sum + agent.outputTokens, 0),
    runCount: members.reduce((sum, agent) => sum + agent.apiRunCount + agent.subscriptionRunCount, 0),
    eventCount: members.reduce((sum, agent) => sum + agent.eventCount, 0),
    estimatedEventCount: members.reduce((sum, agent) => sum + agent.estimatedEventCount, 0),
  })),
};
const models: CostByAgentModel[] = [
  { ...agents[0], provider: "anthropic", biller: "anthropic", billingType: "metered_api", model: "claude-fable-5-1" },
  { ...agents[1], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra" },
  { ...agents[2], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", costCents: 450, inputTokens: 140_000, cachedInputTokens: 1_400_000, outputTokens: 22_000, eventCount: 4, estimatedEventCount: 4 },
  { ...agents[2], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-sol", costCents: 373, inputTokens: 100_000, cachedInputTokens: 1_000_000, outputTokens: 18_000, eventCount: 3, estimatedEventCount: 0 },
  { ...agents[3], provider: "anthropic", biller: "anthropic", billingType: "subscription_included", model: "claude-fable-5-1" },
];
const providerGroups = new Map<string, CostByProviderModel>();
for (const row of models) {
  const key = JSON.stringify([row.provider, row.biller, row.billingType, row.model]);
  const group = providerGroups.get(key) ?? {
    provider: row.provider, biller: row.biller, billingType: row.billingType, model: row.model,
    costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    apiRunCount: 0, subscriptionRunCount: 0,
    subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0,
  };
  group.costCents += row.costCents;
  group.inputTokens += row.inputTokens;
  group.cachedInputTokens += row.cachedInputTokens;
  group.outputTokens += row.outputTokens;
  // Each fixture event represents one distinct run, including Fry's model split.
  if (row.billingType === "subscription_included") {
    group.subscriptionRunCount += row.eventCount;
    group.subscriptionInputTokens += row.inputTokens;
    group.subscriptionCachedInputTokens += row.cachedInputTokens;
    group.subscriptionOutputTokens += row.outputTokens;
  } else {
    group.apiRunCount += row.eventCount;
  }
  providerGroups.set(key, group);
}
const providers = [...providerGroups.values()];
const billers: CostByBiller[] = [...new Set(providers.map(row => row.biller))].map(biller => {
  const rows = providers.filter(row => row.biller === biller);
  return {
    biller,
    costCents: rows.reduce((sum, row) => sum + row.costCents, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    cachedInputTokens: rows.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    apiRunCount: rows.reduce((sum, row) => sum + row.apiRunCount, 0),
    subscriptionRunCount: rows.reduce((sum, row) => sum + row.subscriptionRunCount, 0),
    subscriptionInputTokens: rows.reduce((sum, row) => sum + row.subscriptionInputTokens, 0),
    subscriptionCachedInputTokens: rows.reduce((sum, row) => sum + row.subscriptionCachedInputTokens, 0),
    subscriptionOutputTokens: rows.reduce((sum, row) => sum + row.subscriptionOutputTokens, 0),
    providerCount: new Set(rows.map(row => row.provider)).size,
    modelCount: new Set(rows.map(row => row.model)).size,
  };
});

/** Render the actual Costs page. Fixtures stay inside this Storybook story. */
function CostsPreview() {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const prefix = `/api/companies/${companyId}/`;
      if (!url.pathname.startsWith(prefix)) return previous(input, init);
      const resource = url.pathname.slice(prefix.length);
      if (resource === "costs/finance-summary") return Response.json({ companyId, currency: "USD", debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, providerReportedCents: 0, eventCount: 0, currencies: [] });
      if (resource === "costs/summary") return Response.json({ companyId, spendCents: 42345, budgetCents: 100000, utilizationPercent: 42.35, eventCount: 96, estimatedEventCount: 10, unpricedEventCount: 0, pendingRunCount: 0, pricingComplete: true });
      if (resource === "costs/by-agent") return Response.json(agents);
      if (resource === "costs/by-user") return Response.json(users);
      if (resource === "costs/by-agent-model") return Response.json(models);
      if (resource === "costs/by-project") return Response.json(projects);
      if (resource === "costs/by-provider") return Response.json(providers);
      if (resource === "costs/by-biller") return Response.json(billers);
      if (resource.startsWith("costs/")) return Response.json([]);
      if (resource === "budgets/overview") return Response.json({ companyId, policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
      if (resource.startsWith("accounting/") || resource === "finance-events") return Response.json({ error: "This action is not available in the preview." }, { status: 422 });
      return previous(input, init);
    };
    setSelectedCompanyId(companyId);
    setReady(true);
    return () => { window.fetch = previous; };
  }, [setSelectedCompanyId]);
  if (!ready || selectedCompanyId !== companyId) return null;
  return <main className="mx-auto max-w-6xl p-6"><Costs embedded initialTab="overview" hideBudgetsTab /></main>;
}

const meta = {
  title: "Product/Costs",
  component: CostsPreview,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "The shared Costs page as embedded in the default streamlined UI, with illustrative amounts. Codie has only estimates, Fry is partially estimated, Bender has only reported charges, and Leela uses a subscription. Expand an agent to inspect model labels. Run costs are attributed to Agent orchestration (Bender), Cost reporting (Codie and Fry), and Research (Leela); project costs and tokens reconcile with the agent totals. The existing Finance reports remain available. Charge entry, invoice import/reconciliation, and accounting tools are deferred from the UI." } },
  },
} satisfies Meta<typeof CostsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
