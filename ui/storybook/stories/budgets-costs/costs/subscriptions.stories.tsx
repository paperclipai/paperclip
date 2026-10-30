import { useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { monthlySubscriptionCents, type SubscriptionCostReport, type CostDataQualityReport } from "@paperclipai/shared";
import { Costs } from "@/pages/Costs";
import { ToastViewport } from "@/components/ToastViewport";

function fixture(): SubscriptionCostReport {
  const zero = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: "0", eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0 };
  const price = { revision: 0, plan: "ChatGPT Plus", amountCents: "2000", monthlyCents: "2000", currency: "USD", cadence: "month" as const, status: "active" as const, source: "catalog" as const, sourceUrl: "https://learn.chatgpt.com/docs/pricing", effectiveAt: "2026-10-08T00:00:00Z" };
  return { canRefresh: true, asOf: new Date().toISOString(), activeCount: 2, unknownPriceCount: 0, unidentifiedAccountCount: 0,
    monthlyTotals: [{ currency: "USD", amountCents: "12000", estimatedCount: 2 }],
    api: { ...zero, costCents: "4217", inputTokens: 6000000, cachedInputTokens: 6200000, outputTokens: 200000, eventCount: 24, estimatedEventCount: 12 },
    subscription: { ...zero, inputTokens: 10000000, cachedInputTokens: 74000000, outputTokens: 1100000, eventCount: 50 },
    unknown: { ...zero }, unattributedSubscription: { ...zero },
    accounts: [
      { id: "plus", provider: "openai", name: "Goldie’s ChatGPT", ownerUserId: "goldie", ownerName: "Goldie", shared: false, identityVerified: true,
        detectedPlan: "plus", observedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), refreshStatus: "ok", canEdit: true,
        price, usage: { ...zero, inputTokens: 8000000, cachedInputTokens: 60000000, outputTokens: 1000000, eventCount: 40 }, agents: [{ id: "codie", name: "Codie" }, { id: "fry", name: "Fry" }] },
      { id: "max", provider: "anthropic", name: "Shared Claude", ownerUserId: null, ownerName: null, shared: true, identityVerified: true,
        detectedPlan: "max_5x", observedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString(), refreshStatus: "ok", canEdit: true,
        price: { ...price, plan: "Claude Max 5x", amountCents: "10000", monthlyCents: "10000", sourceUrl: "https://claude.com/pricing" },
        usage: { ...zero, inputTokens: 2000000, cachedInputTokens: 14000000, outputTokens: 100000, eventCount: 10 }, agents: [{ id: "leela", name: "Leela" }] },
    ],
  };
}

/** Production Costs page; only API responses are fixtures. Edits persist in the story. */
function SubscriptionCostsStory({ unknownPrice = false, stale = false, costGaps = false }: { unknownPrice?: boolean; stale?: boolean; costGaps?: boolean }) {
  const [ready, setReady] = useState(false);
  const client = useQueryClient();
  useLayoutEffect(() => {
    const original = window.fetch;
    const report = fixture();
    const details: CostDataQualityReport = { canRetry: true, hasMoreEvents: false, hasMoreRuns: false,
      events: [
        { id: "unknown-billing", runId: "run-openrouter", agentId: "codie", agentName: "Codie", occurredAt: "2026-10-09T10:00:00Z", provider: "openrouter", model: "deepseek-v4", reason: "unknown_billing" },
        { id: "missing-model", runId: "run-default-model", agentId: "fry", agentName: "Fry", occurredAt: "2026-10-09T09:00:00Z", provider: "openai", model: "unknown", reason: "missing_model" },
        { id: "missing-price", runId: "run-old-receipt", agentId: "leela", agentName: "Leela", occurredAt: "2026-10-02T09:00:00Z", provider: "openai", model: "gpt-6-astra", reason: "missing_price" },
      ],
      runs: [
        { id: "receiving", runId: "receiving", agentId: "codie", agentName: "Codie", occurredAt: new Date().toISOString(), provider: "openai", model: "gpt-6-astra", reason: "waiting_for_receipt" },
        { id: "unavailable", runId: "unavailable", agentId: "leela", agentName: "Leela", occurredAt: "2026-10-08T12:00:00Z", provider: "anthropic", model: "claude-opus-4-6", reason: "receipt_unavailable" },
        { id: "ready", runId: "ready", agentId: "fry", agentName: "Fry", occurredAt: "2026-10-09T12:00:00Z", provider: "openai", model: "gpt-6-astra", reason: "retryable" },
      ],
    };
    if (unknownPrice) {
      report.accounts[1].price = { ...report.accounts[1].price, plan: "Claude Max", amountCents: null, monthlyCents: null, source: "unknown", sourceUrl: null };
      report.accounts[1].detectedPlan = "max";
      report.unknownPriceCount = 1; report.monthlyTotals = [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }];
    }
    if (stale) report.accounts.forEach(account => { account.refreshStatus = "unavailable"; account.observedAt = "2026-10-06T10:00:00Z"; });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const base = "/api/companies/company-storybook/";
      const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : "";
      if (path === "costs/subscriptions/refresh") return Response.json({ status: "accepted" }, { status: 202 });
      if (path === "costs/subscriptions") return Response.json(report);
      if (path === "costs/data-quality") return Response.json(details);
      if (path === "costs/retry-accounting" && init?.method === "POST") {
        const { runId } = JSON.parse(String(init.body));
        details.runs = details.runs.filter(row => row.runId !== runId);
        return Response.json({ accounted: true });
      }
      if (path.startsWith("costs/subscriptions/") && init?.method === "PATCH") {
        const account = report.accounts.find(row => row.id === path.split("/")[2])!;
        const patch = JSON.parse(String(init.body));
        account.price = { ...account.price, ...patch, source: "user", sourceUrl: null, revision: account.price.revision + 1,
          monthlyCents: patch.amountCents == null ? null : monthlySubscriptionCents(patch.amountCents, patch.cadence), effectiveAt: new Date().toISOString() };
        report.monthlyTotals = [];
        report.activeCount = 0; report.unknownPriceCount = 0;
        for (const row of report.accounts) {
          if (row.price.status !== "active") continue;
          report.activeCount++;
          if (row.price.monthlyCents == null) { report.unknownPriceCount++; continue; }
          let total = report.monthlyTotals.find(total => total.currency === row.price.currency);
          if (!total) report.monthlyTotals.push(total = { currency: row.price.currency, amountCents: "0", estimatedCount: 0 });
          total.amountCents = String(Number(total.amountCents) + Number(row.price.monthlyCents));
          total.estimatedCount += row.price.source === "catalog" ? 1 : 0;
        }
        return Response.json({ id: account.id });
      }
      if (path === "budgets/overview") return Response.json({ policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
      if (path === "costs/summary") return Response.json({ spendCents: 4217, budgetCents: 20000, utilizationPercent: 21, pricingComplete: !costGaps, eventCount: 74, estimatedEventCount: 12, unpricedEventCount: costGaps ? 2 : 0, pendingRunCount: costGaps ? details.runs.length : 0, unknownBillingEventCount: costGaps ? 1 : 0 });
      if (path === "costs/by-agent") return Response.json([
        { agentId: "codie", agentName: "Codie", agentStatus: "active", costCents: 4217, inputTokens: 12000000, cachedInputTokens: 56200000, outputTokens: 1000000, eventCount: 54, estimatedEventCount: 12, apiRunCount: 24, subscriptionRunCount: 30 },
        { agentId: "fry", agentName: "Fry", agentStatus: "active", costCents: 0, inputTokens: 2000000, cachedInputTokens: 10000000, outputTokens: 200000, eventCount: 10, estimatedEventCount: 0, apiRunCount: 0, subscriptionRunCount: 10 },
        { agentId: "leela", agentName: "Leela", agentStatus: "active", costCents: 0, inputTokens: 2000000, cachedInputTokens: 14000000, outputTokens: 100000, eventCount: 10, estimatedEventCount: 0, apiRunCount: 0, subscriptionRunCount: 10 },
      ]);
      if (path === "costs/by-user") return Response.json({ activeUserCount: 1, rows: [{ userId: "goldie", userName: "Goldie", userImage: null, costCents: 4217, costCentsExact: "4217", inputTokens: 16000000, cachedInputTokens: 80200000, outputTokens: 1300000, eventCount: 74, estimatedEventCount: 12, unpricedEventCount: 0, runCount: 74 }] });
      if (path === "costs/by-project") return Response.json([{ projectId: "costs-project", projectName: "Cost reporting", costCents: 4217, inputTokens: 16000000, cachedInputTokens: 80200000, outputTokens: 1300000, eventCount: 74, estimatedEventCount: 12 }]);
      if (path === "costs/finance-summary") return Response.json({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0, currencies: [] });
      if (path.startsWith("costs/")) return Response.json([]);
      return original(input, init);
    };
    client.removeQueries({ queryKey: ["cost-subscriptions"] }); client.removeQueries({ queryKey: ["costs"] }); setReady(true);
    return () => { window.fetch = original; client.removeQueries({ queryKey: ["cost-subscriptions"] }); client.removeQueries({ queryKey: ["costs"] }); };
  }, [client, unknownPrice, stale, costGaps]);
  return ready ? <><Costs embedded hideBudgetsTab /><ToastViewport /></> : null;
}

const meta = { id: "costs-subscriptions",
  title: "Oversight and operation/Costs and budgets/Costs/Subscriptions", component: SubscriptionCostsStory, parameters: {
  layout: "padded", docs: { description: { component: "Production Costs page with API spend, monthly subscription estimates, user and project costs. View details to edit monthly or annual prices. Provider calls are fixtures." } },
    paperclip: {
      "capabilities": [
        "budgets-costs/cost-reporting",
        "budgets-costs/budgets"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "The upstream budget UI distinguishes soft warnings from hard stops; hard incidents retain raise-and-resume and keep-paused controls."
    },
  } } satisfies Meta<typeof SubscriptionCostsStory>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Overview: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText("API spend")).toBeVisible();
  await expect(await canvas.findByText("$120.00")).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "12 estimated charges" })).not.toBeInTheDocument();
  await expect(canvas.queryByText(/Includes 12 estimated charges/)).not.toBeInTheDocument();
} };
export const AccountDetails: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "View details" }));
  const dialog = within(document.body);
  await expect(await dialog.findByText("Goldie’s ChatGPT")).toBeVisible();
  await expect(await dialog.findByText("Used by Codie, Fry")).toBeVisible();
} };
export const UnknownPrice: Story = { args: { unknownPrice: true } };
export const ProviderUnavailable: Story = { args: { stale: true } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const CostDataQuality: Story = { args: { costGaps: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("button", { name: "5 run costs unavailable" })).toHaveAttribute("aria-expanded", "false");
  await expect(canvas.queryByText(/Includes 12 estimated charges/)).not.toBeInTheDocument();
} };
export const CostDataQualityDetails: Story = { args: { costGaps: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "5 run costs unavailable" }));
  await expect(await canvas.findByText("Model not reported")).toBeVisible();
  await expect(await canvas.findByRole("button", { name: "Retry cost recording" })).toBeVisible();
  const groups = canvas.getByRole("list", { name: "Cost details by agent" });
  await expect(within(groups).getAllByRole("heading").map(heading => heading.textContent)).toEqual(["Codie", "Fry", "Leela"]);
  await expect(canvas.getAllByRole("link", { name: "View run" })).toHaveLength(6);
  await expect(within(groups).getAllByRole("link", { name: /^(Codie|Fry|Leela)$/ })).toHaveLength(3);
  await expect(canvas.queryByRole("link", { name: "Configuration" })).not.toBeInTheDocument();
  await expect(canvas.queryByText("Totals include known charges only.")).not.toBeInTheDocument();
  await expect(canvas.queryByText(/Includes 12 estimated charges/)).not.toBeInTheDocument();
} };
