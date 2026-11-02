// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { Dashboard } from "./Dashboard";

const mocks = vi.hoisted(() => ({ breadcrumbs: vi.fn(), openOnboarding: vi.fn() }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", companies: [{ id: "company-1" }] }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: mocks.openOnboarding }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/QA/dashboard" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({}), usePublishSharedQueryData: () => {} }));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("../components/ActivityCharts", () => ({
  ChartCard: () => null, RunActivityChart: () => null, PriorityChart: () => null,
  IssueStatusChart: () => null, SuccessRateChart: () => null,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

describe("Dashboard budget localization", () => {
  it("switches a fractional percentage and currency without changing cached costs", async () => {
    const costs = { monthSpendCents: 1250, monthBudgetCents: 10000, monthUtilizationPercent: 12.5 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.agents.list("company-1"), [{ id: "agent-1", name: "Raw agent", status: "idle" }]);
    client.setQueryData(queryKeys.dashboard("company-1"), {
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      tasks: { inProgress: 0, open: 0, blocked: 0 }, costs, pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0 }, runActivity: [],
    });
    client.setQueryData([...queryKeys.activity("company-1"), { limit: 10 }], []);
    client.setQueryData(queryKeys.issues.list("company-1"), []);
    client.setQueryData(queryKeys.projects.list("company-1", { includeArchived: true }), []);
    client.setQueryData(queryKeys.access.companyUserDirectory("company-1"), { users: [] });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>); });
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        const description = host.querySelector('a[href="/costs"]')?.textContent?.replace(/\u00a0/g, " ");
        expect(description).toContain(locale === "ru" ? "12,5% от бюджета 100,00 $" : "12.5% of $100.00 budget");
        expect(description).toContain(locale === "ru" ? "12,50 $" : "$12.50");
        expect(client.getQueryData<{ costs: typeof costs }>(queryKeys.dashboard("company-1"))?.costs).toEqual(costs);
        expect(mocks.openOnboarding).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
});
