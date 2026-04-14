// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  companies: [{ id: "company-1", name: "Comandero" }],
}));

const dialogState = vi.hoisted(() => ({
  openOnboarding: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const mockDashboardApi = vi.hoisted(() => ({
  summary: vi.fn(),
}));

const mockExecutiveSummaryApi = vi.hoisted(() => ({
  getSummary: vi.fn(),
  replaceKpis: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

vi.mock("../api/executiveSummary", () => ({
  executiveSummaryApi: mockExecutiveSummaryApi,
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div>Active agents panel</div>,
}));

vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h4>{title}</h4>
      <div>{children}</div>
    </section>
  ),
  RunActivityChart: () => <div>run chart</div>,
  PriorityChart: () => <div>priority chart</div>,
  IssueStatusChart: () => <div>issue status chart</div>,
  SuccessRateChart: () => <div>success chart</div>,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>loading</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/ActivityRow", () => ({
  ActivityRow: ({ event }: { event: { action: string } }) => <div>{event.action}</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function renderDashboard(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("Dashboard executive brief", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    breadcrumbsState.setBreadcrumbs.mockReset();
    dialogState.openOnboarding.mockReset();
    mockDashboardApi.summary.mockReset();
    mockExecutiveSummaryApi.getSummary.mockReset();
    mockExecutiveSummaryApi.replaceKpis.mockReset();
    mockActivityApi.list.mockReset();
    mockIssuesApi.list.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockHeartbeatsApi.list.mockReset();

    mockDashboardApi.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 2, running: 1, paused: 0, error: 1 },
      tasks: { open: 9, inProgress: 4, blocked: 2, done: 3 },
      costs: { monthSpendCents: 4200, monthBudgetCents: 10000, monthUtilizationPercent: 42 },
      pendingApprovals: 1,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      brief: {
        health: "at_risk",
        snapshot: {
          progress: { value: "4", label: "In flight", headline: "Work is moving", detail: "3 completed recently", tone: "healthy" },
          risk: { value: "2", label: "Blocked", headline: "Checkout is at risk", detail: "1 failed run on active work", tone: "at_risk" },
          decisions: { value: "3", label: "Waiting", headline: "Board input required", detail: "1 approval, 1 join request, 1 blocked ownerless issue", tone: "watch" },
          spend: { value: "$42.00", label: "Month spend", headline: "Budget is under control", detail: "42% of monthly budget", tone: "healthy" },
        },
        focusAreas: [
          {
            key: "checkout-trust",
            label: "Checkout trust",
            tone: "blocked",
            changedIssueCount: 4,
            blockedCount: 2,
            failedRunCount: 1,
            activeAgentCount: 2,
            latestUpdate: "QA re-audit failed after optimizer fix",
            href: "/issues?projectId=project-1",
          },
        ],
        needsAttention: [
          {
            key: "run:1",
            kind: "run",
            entityId: "run-1",
            title: "QA Runner failed on COMA-1063 Merge branches",
            reason: "Failed active run",
            severity: "high",
            timestamp: new Date("2026-04-14T10:00:00.000Z"),
            href: "/agents/agent-1/runs/run-1",
            ctaLabel: "Inspect failure",
          },
        ],
      },
    } as any);

    mockExecutiveSummaryApi.getSummary.mockResolvedValue({
      computedKpis: {
        monthSpendCents: 4200,
        monthBudgetCents: 10000,
        monthUtilizationPercent: 42,
        tasksOpen: 9,
        tasksInProgress: 4,
        tasksBlocked: 2,
        tasksDone: 3,
        pendingApprovals: 1,
        activeBudgetIncidents: 0,
        pausedAgents: 0,
        pausedProjects: 0,
      },
      dispatch: { enabled: false, lastSentAt: null, lastStatus: null, lastError: null, recipients: [] },
      manualKpis: [],
      topChanges: { issueTransitions: [], failedRuns: [], pendingApprovals: 1 },
    });
    mockActivityApi.list.mockResolvedValue([{ id: "evt-1", action: "issue.updated" }]);
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the executive brief above the operational detail", async () => {
    const { root } = renderDashboard(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Company State");
      expect(container.textContent).toContain("Snapshot");
      expect(container.textContent).toContain("Focus Areas");
      expect(container.textContent).toContain("Do These Next");
      expect(container.textContent).toContain("Operational Detail");
      expect(container.textContent).toContain("Checkout trust");
      expect(container.textContent).toContain("QA Runner failed on COMA-1063 Merge branches");
      expect(container.textContent).toContain("Inspect failure");
    });

    const text = container.textContent ?? "";
    expect(text.indexOf("Company State")).toBeLessThan(text.indexOf("Operational Detail"));
    expect(text.indexOf("Focus Areas")).toBeLessThan(text.indexOf("Executive Summary"));

    act(() => {
      root.unmount();
    });
  });

  it("renders a clean company-state message when there is no active work", async () => {
    mockDashboardApi.summary.mockResolvedValueOnce({
      companyId: "company-1",
      agents: { active: 0, running: 0, paused: 0, error: 0 },
      tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 10000, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      brief: {
        health: "healthy",
        snapshot: {
          progress: { value: "0", label: "In flight", headline: "No active work in flight", detail: "0 completed recently", tone: "healthy" },
          risk: { value: "0", label: "Blocked", headline: "No critical execution risk right now", detail: "0 failed runs on active work", tone: "healthy" },
          decisions: { value: "0", label: "Waiting", headline: "No board decisions waiting", detail: "0 approvals, 0 join requests, 0 board-owned issues", tone: "healthy" },
          spend: { value: "$0.00", label: "Month spend", headline: "Budget is under control", detail: "0% of monthly budget", tone: "healthy" },
        },
        focusAreas: [],
        needsAttention: [],
      },
    } as any);

    const { root } = renderDashboard(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("There is no active company work in flight right now.");
      expect(container.textContent).toContain("No material workstream movement right now.");
      expect(container.textContent).toContain("No board actions are waiting right now.");
    });

    act(() => {
      root.unmount();
    });
  });
});
