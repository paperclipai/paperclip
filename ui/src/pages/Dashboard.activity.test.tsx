import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { Dashboard } from "./Dashboard";

const state = vi.hoisted(() => ({
  companyId: "company-1" as string | null,
  sandbox: false,
  openOnboarding: vi.fn(),
  setBreadcrumbs: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/dashboard" }),
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: state.companyId, companies: [{ id: "company-1" }, { id: "company-2" }] }),
}));
vi.mock("../context/DesignSandboxContext", () => ({ useDesignSandbox: () => state.sandbox }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: state.openOnboarding }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.setBreadcrumbs }) }));
vi.mock("../hooks/useSharedPolling", () => ({ useSharedPollingQuery: () => ({}), usePublishSharedQueryData: () => {} }));
vi.mock("../components/TaskSummaryList", () => ({ TaskSummaryList: () => null }));
vi.mock("../components/ActiveAgentsPanel", () => ({ ActiveAgentsPanel: () => null }));
vi.mock("../components/SmokeLabDashboardCard", () => ({ SmokeLabDashboardCard: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("../components/ActivityCharts", () => ({
  ChartCard: () => null,
  RunActivityChart: () => null,
  PriorityChart: () => null,
  IssueStatusChart: () => null,
  SuccessRateChart: () => null,
}));

const pluginId = "62c3f549-12e8-4ad4-a267-e0dfc4b4c011";
const clients: QueryClient[] = [];

function createClient(companyId = "company-1", actorId = pluginId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  clients.push(client);
  client.setQueryData(queryKeys.dashboard(companyId), {
    agents: { active: 1, running: 0, paused: 0, error: 0 },
    tasks: { inProgress: 0, open: 0, blocked: 0 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0 },
    budgets: { activeIncidents: 0, pendingApprovals: 0 },
    pendingApprovals: 0,
  });
  client.setQueryData([...queryKeys.activity(companyId), { limit: 10 }], [{
    id: `activity-${companyId}`,
    companyId,
    actorType: "plugin",
    actorId,
    action: "issue.updated",
    entityType: "issue",
    entityId: "issue-1",
    details: null,
    createdAt: new Date("2026-11-02T00:00:00Z"),
  }]);
  client.setQueryData(queryKeys.agents.list(companyId), [{ id: "agent-1", name: "Agent", status: "idle" }]);
  client.setQueryData(queryKeys.issues.list(companyId), []);
  client.setQueryData(queryKeys.projects.list(companyId, { includeArchived: true }), []);
  client.setQueryData(queryKeys.access.companyUserDirectory(companyId), { users: [] });
  return client;
}

function renderDashboard(client: QueryClient) {
  return renderToStaticMarkup(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>);
}

beforeEach(() => {
  state.companyId = "company-1";
  state.sandbox = false;
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

describe.each([false, true])("Dashboard plugin actors with sandbox=%s", (sandbox) => {
  beforeEach(() => { state.sandbox = sandbox; });

  it("reads display names from the plugin API cache", async () => {
    const client = createClient();
    const fetch = vi.fn().mockResolvedValue(Response.json([{ id: pluginId, manifestJson: { displayName: "Kitchen Sink (Example)" } }]));
    vi.stubGlobal("fetch", fetch);
    await client.fetchQuery({ queryKey: queryKeys.plugins.all, queryFn: () => pluginsApi.list() });
    const html = renderDashboard(client);
    expect(html).toContain("Kitchen Sink (Example)");
    expect(html).not.toContain(pluginId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/plugins");
  });

  it("keeps activity readable while the directory is unavailable or a plugin is uninstalled", () => {
    const client = createClient();
    expect(renderDashboard(client)).toContain("Plugin (62c3f549)");
    client.setQueryData(queryKeys.plugins.all, []);
    expect(renderDashboard(client)).toContain("Plugin (62c3f549)");
  });

  it.each([403, 500])("drops cached names after a failed directory read (%s)", async (status) => {
    const client = createClient();
    client.setQueryData(queryKeys.plugins.all, [{ id: pluginId, manifestJson: { displayName: "Cached plugin" } }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Directory unavailable" }, { status })));
    await expect(client.fetchQuery({ queryKey: queryKeys.plugins.all, queryFn: () => pluginsApi.list(), staleTime: 0 })).rejects.toThrow();
    const html = renderDashboard(client);
    expect(html).toContain("Plugin (62c3f549)");
    expect(html).not.toContain("Cached plugin");
  });

  it("uses the selected company's activity with the instance plugin directory", () => {
    const client = createClient("company-2", "another-plugin-id");
    state.companyId = "company-2";
    client.setQueryData(queryKeys.plugins.all, [{ id: pluginId, manifestJson: { displayName: "Other activity's plugin" } }]);
    const html = renderDashboard(client);
    expect(html).toContain("Plugin (another-)");
    expect(html).not.toContain("Other activity&#x27;s plugin");
  });
});
