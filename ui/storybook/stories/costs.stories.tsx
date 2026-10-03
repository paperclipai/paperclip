import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CostByAgent, CostByAgentModel, CostByProject } from "@paperclipai/shared";
import { Costs } from "@/pages/Costs";
import { useCompany } from "@/context/CompanyContext";

import { createCostsFinanceFixtures } from "../fixtures/costsFinance";

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
const models: CostByAgentModel[] = [
  { ...agents[0], provider: "anthropic", biller: "anthropic", billingType: "metered_api", model: "claude-fable-5-1" },
  { ...agents[1], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra" },
  { ...agents[2], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", costCents: 450, inputTokens: 140_000, cachedInputTokens: 1_400_000, outputTokens: 22_000, eventCount: 4, estimatedEventCount: 4 },
  { ...agents[2], provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-sol", costCents: 373, inputTokens: 100_000, cachedInputTokens: 1_000_000, outputTokens: 18_000, eventCount: 3, estimatedEventCount: 0 },
  { ...agents[3], provider: "anthropic", biller: "anthropic", billingType: "subscription_included", model: "claude-fable-5-1" },
];

/** Render the actual Costs page. Fixtures stay inside this Storybook story. */
function CostsPreview() {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    const finance = createCostsFinanceFixtures(companyId);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const prefix = `/api/companies/${companyId}/`;
      if (!url.pathname.startsWith(prefix)) return previous(input, init);
      const resource = url.pathname.slice(prefix.length);
      const fixture = await finance(resource, new Request(input instanceof Request ? input : url, init));
      if (fixture) return fixture;
      if (resource === "costs/summary") return Response.json({ companyId, spendCents: 42345, budgetCents: 100000, utilizationPercent: 42.35, eventCount: 96, estimatedEventCount: 10, unpricedEventCount: 0, pendingRunCount: 0, pricingComplete: true });
      if (resource === "costs/by-agent") return Response.json(agents);
      if (resource === "costs/by-agent-model") return Response.json(models);
      if (resource === "costs/by-project") return Response.json(projects);
      if (resource.startsWith("costs/")) return Response.json([]);
      if (resource === "budgets/overview") return Response.json({ companyId, policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
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
    docs: { description: { component: "The shared Costs page as embedded in the default streamlined UI, with illustrative amounts. Codie has only estimates, Fry is partially estimated, Bender has only reported charges, and Leela uses a subscription. Expand an agent to inspect model labels. Run costs are attributed to Agent orchestration (Bender), Cost reporting (Codie and Fry), and Research (Leela); project costs and tokens reconcile with the agent totals. Finance entry, invoice review, and provider report imports use per-mount in-memory fixtures; they never contact a provider. Imported invoice lines remain unmatched because the preview does not contain a real ledger." } },
  },
} satisfies Meta<typeof CostsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = {};
