// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let container: HTMLDivElement;
let root: Root;

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

beforeEach(() => {
  state.companyId = "company-1";
  state.sandbox = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
});

async function mount(client: QueryClient) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Dashboard /></QueryClientProvider>);
  });
}

async function settle(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    check();
  });
}

describe.each([false, true])("Dashboard plugin actors with sandbox=%s", (sandbox) => {
  beforeEach(() => { state.sandbox = sandbox; });

  it("fetches one directory for ten rows and updates pending labels", async () => {
    const client = createClient();
    const activityKey = [...queryKeys.activity("company-1"), { limit: 10 }];
    const events = client.getQueryData<object[]>(activityKey)!;
    client.setQueryData(activityKey, Array.from({ length: 10 }, (_, index) => ({ ...events[0], id: `activity-${index}` })));
    let answer!: (response: Response) => void;
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    vi.stubGlobal("fetch", fetch);
    expect(client.getQueryData(queryKeys.plugins.all)).toBeUndefined();
    await mount(client);
    expect(container.textContent?.match(/Plugin \(62c3f549\)/g)).toHaveLength(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/plugins");
    await act(async () => {
      answer(Response.json([{ id: pluginId, manifestJson: { displayName: "Kitchen Sink (Example)" } }]));
    });
    await settle(() => expect(container.textContent?.match(/Kitchen Sink \(Example\)/g)).toHaveLength(10));
    expect(container.textContent).not.toContain(pluginId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not fetch the directory for non-plugin activity", async () => {
    const client = createClient();
    const key = [...queryKeys.activity("company-1"), { limit: 10 }];
    client.setQueryData<object[]>(key, (events) => (events ?? []).map((event) => ({ ...event, actorType: "system" })));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await mount(client);
    expect(container.textContent).toContain("System");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([403, 500])("keeps activity readable after %s without retries", async (status) => {
    const client = createClient();
    client.setQueryDefaults(queryKeys.plugins.all, { retry: 2, retryDelay: 0 });
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "Directory unavailable" }, { status }));
    vi.stubGlobal("fetch", fetch);
    await mount(client);
    await settle(() => expect(client.getQueryState(queryKeys.plugins.all)?.status).toBe("error"));
    expect(container.textContent).toContain("Plugin (62c3f549)");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("drops a cached name when a directory refresh fails", async () => {
    const client = createClient();
    client.setQueryData(queryKeys.plugins.all, [{ id: pluginId, manifestJson: { displayName: "Cached plugin" } }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Directory unavailable" }, { status: 403 })));
    await mount(client);
    expect(container.textContent).toContain("Cached plugin");
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.plugins.all }); });
    await settle(() => expect(container.textContent).toContain("Plugin (62c3f549)"));
    expect(container.textContent).not.toContain("Cached plugin");
  });

  it("updates a renamed plugin and falls back after uninstall", async () => {
    const client = createClient();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: pluginId, manifestJson: { displayName: "Old name" } }]))
      .mockResolvedValueOnce(Response.json([{ id: pluginId, manifestJson: { displayName: "New name" } }]))
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await mount(client);
    await settle(() => expect(container.textContent).toContain("Old name"));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.plugins.all }); });
    await settle(() => expect(container.textContent).toContain("New name"));
    expect(container.textContent).not.toContain("Old name");
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.plugins.all }); });
    await settle(() => expect(container.textContent).toContain("Plugin (62c3f549)"));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not request a directory without a selected company", async () => {
    const client = createClient();
    state.companyId = null;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await mount(client);
    expect(container.textContent).toContain("Create or select an organization");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the selected company's activity with the instance plugin directory", async () => {
    const client = createClient("company-2", "another-plugin-id");
    state.companyId = "company-2";
    client.setQueryData(queryKeys.plugins.all, [{ id: pluginId, manifestJson: { displayName: "Other activity's plugin" } }]);
    await mount(client);
    expect(container.textContent).toContain("Plugin (another-)");
    expect(container.textContent).not.toContain("Other activity's plugin");
  });
});
