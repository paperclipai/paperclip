import { useLayoutEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { CompanySettings } from "@/pages/CompanySettings";
import { Costs } from "@/pages/Costs";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { choices, companyId, configured, entry, result, unconfigured } from "./fixtures";
import type { DecisionHistoryEntry } from "@paperclipai/shared";

/** Production pages and shell; only API responses and paid provider execution are simulated. */
function Journey({ alreadyConfigured = false }: { alreadyConfigured?: boolean }) {
  const [ready, setReady] = useState(false);
  const queryClient = useQueryClient();
  useLayoutEffect(() => {
    const original = window.fetch;
    let settings = { ...(alreadyConfigured ? configured : unconfigured) };
    const history: DecisionHistoryEntry[] = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      const base = `/api/companies/${companyId}/decision-model`;
      if (url.pathname === base) {
        if (init?.method === "PUT") {
          const data = JSON.parse(String(init.body));
          const selected = choices.find(row => row.grantId === data.grantId)!;
          settings = { ...settings, ...data, provider: selected.provider, model: selected.decisionModel };
          return Response.json(settings);
        }
        return Response.json({ settings, choices, canManage: true });
      }
      if (url.pathname === `${base}/history`) return Response.json(history);
      if (url.pathname === `${base}/test`) {
        history.unshift({ ...entry, id: `decision-${history.length}`, model: settings.model!, provider: settings.provider! });
        return Response.json(result);
      }
      if (url.pathname === `/api/companies/${companyId}/budgets/overview`) return Response.json({ companyId,
        policies: [], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0, pendingApprovalCount: 0 });
      const costBase = `/api/companies/${companyId}/costs/`;
      if (url.pathname.startsWith(costBase)) {
        const report = url.pathname.slice(costBase.length);
        if (report === "summary") return Response.json({ companyId, eventCount: history.length, pendingRunCount: 0,
          unpricedEventCount: 0, estimatedEventCount: history.length, pricingComplete: true,
          spendCents: history.length * Number(entry.costCents), budgetCents: 0, utilizationPercent: 0 });
        if (report === "finance-summary") return Response.json({ companyId, currency: "USD", currencies: [], debitCents: 0,
          creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 });
        if (report === "by-user") return Response.json({ activeUserCount: 1, rows: [] });
        if (report === "by-agent") return Response.json(history.length ? [{ agentId: null, agentName: null, agentStatus: null,
          eventCount: history.length, estimatedEventCount: history.length, costCents: history.length * Number(entry.costCents),
          inputTokens: history.length * entry.inputTokens!, cachedInputTokens: 0, outputTokens: 0 }] : []);
        return Response.json([]);
      }
      return original(input, init);
    };
    setReady(true);
    return () => { window.fetch = original; queryClient.removeQueries({ queryKey: ["decision-model"] }); queryClient.removeQueries({ queryKey: ["decision-history"] }); };
  }, [alreadyConfigured, queryClient]);
  return ready ? <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="company/settings" element={<CompanySettings />} />
    <Route path="activity/costs" element={<Costs />} />
  </Route></Routes></PluginLauncherProvider> : null;
}
const meta = { title: "Decision models/03 Journey", component: Journey, parameters: {
  layout: "fullscreen", initialEntries: ["/PAP/company/settings"], docs: { story: { inline: false }, description: { component: "Select an existing shared connection, preserve the background setting, save, run the sample, and follow View usage. Paid calls are fixtures." } },
} } satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SetupToHistory: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("button", { name: /Company OpenAI/ }));
  await userEvent.click(c.getByRole("button", { name: "Save decision model" }));
  await waitFor(() => expect(c.getByRole("button", { name: "Run test" })).toBeEnabled());
  await userEvent.click(await c.findByRole("button", { name: "Run test" }));
  await expect(await c.findByText("Decision model is working")).toBeVisible();
  await userEvent.click(c.getByRole("link", { name: "View usage" }));
  await expect(await c.findByRole("table", { name: "Decision requests" })).toHaveTextContent("Setup test");
} };
export const ReturningManager: Story = { args: { alreadyConfigured: true } };
export const Mobile: Story = { args: { alreadyConfigured: true }, globals: { viewport: { value: "mobile1", isRotated: false } } };
