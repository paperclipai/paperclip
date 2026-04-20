// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      status: "active",
      brandColor: "#123456",
      issuePrefix: "PAP",
    },
  ],
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openOnboarding: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const dashboardApiMock = vi.hoisted(() => ({
  summary: vi.fn(),
}));

const activityApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const issuesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const heartbeatsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const costsApiMock = vi.hoisted(() => ({
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
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
  dashboardApi: dashboardApiMock,
}));

vi.mock("../api/activity", () => ({
  activityApi: activityApiMock,
}));

vi.mock("../api/issues", () => ({
  issuesApi: issuesApiMock,
}));

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("../api/projects", () => ({
  projectsApi: projectsApiMock,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: heartbeatsApiMock,
}));

vi.mock("../api/costs", () => ({
  costsApi: costsApiMock,
}));

vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div data-testid="active-agents-panel" />,
}));

vi.mock("../components/ActivityRow", () => ({
  ActivityRow: () => null,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  RunActivityChart: () => <div />,
  PriorityChart: () => <div />,
  IssueStatusChart: () => <div />,
  SuccessRateChart: () => <div />,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading dashboard</div>,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function makeProviderUsageRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    biller: "chatgpt",
    billingType: "subscription_included",
    inputTokens: 1200,
    cachedInputTokens: 0,
    outputTokens: 300,
    costCents: 0,
    apiRunCount: 0,
    subscriptionRunCount: 1,
    subscriptionInputTokens: 1200,
    subscriptionOutputTokens: 300,
    ...overrides,
  };
}

function makeBillerUsageRow(overrides: Record<string, unknown> = {}) {
  return {
    biller: "openrouter",
    costCents: 1234,
    inputTokens: 1200,
    cachedInputTokens: 300,
    outputTokens: 500,
    apiRunCount: 2,
    subscriptionRunCount: 1,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    providerCount: 1,
    modelCount: 1,
    ...overrides,
  };
}

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDashboard() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>,
    );
  });

  await flushQueries();
  return queryClient;
}

beforeEach(() => {
  dashboardApiMock.summary.mockResolvedValue({
    companyId: "company-1",
    agents: { active: 2, running: 1, paused: 0, error: 0 },
    tasks: { open: 3, inProgress: 1, blocked: 0, done: 4 },
    costs: {
      monthSpendCents: 125,
      monthBudgetCents: 2500,
      monthUtilizationPercent: 5,
      workValue: {
        companyId: "company-1",
        totalTokens: 125000,
        inputTokens: 90000,
        cachedInputTokens: 10000,
        outputTokens: 25000,
        aiSpendCents: 125,
        estimatedDevHours: 1.25,
        estimatedDevValueCents: 18750,
        estimatedSavingsCents: 18625,
        roiMultiple: 150,
        devValueHourlyRateCents: 15000,
        devValueTokensPerHour: 100000,
      },
      codexProjectsEstimate: {
        labelName: "Codex",
        windowDays: 7,
        windowStart: "2026-04-08T12:00:00.000Z",
        windowEnd: "2026-04-15T12:00:00.000Z",
        projectCount: 4,
        activeProjectDays: 22.75,
        projectWeekEquivalent: 3.25,
        totalTokens: 420000,
        inputTokens: 310000,
        cachedInputTokens: 80000,
        outputTokens: 30000,
        estimatedDevHours: 4.2,
        estimatedDevValueCents: 63000,
        devValueHourlyRateCents: 15000,
        devValueTokensPerHour: 100000,
        assumption: "Estimated from tokens attributed to current Codex-labeled projects over the last 7 days. This is not billed spend.",
      },
    },
    pendingApprovals: 0,
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
  });
  activityApiMock.list.mockResolvedValue([]);
  issuesApiMock.list.mockResolvedValue([]);
  agentsApiMock.list.mockResolvedValue([]);
  projectsApiMock.list.mockResolvedValue([]);
  heartbeatsApiMock.list.mockResolvedValue([]);
  costsApiMock.byProvider.mockResolvedValue([]);
  costsApiMock.byBiller.mockResolvedValue([]);
  costsApiMock.quotaWindows.mockResolvedValue([]);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("Dashboard codex limits card", () => {
  it("renders the estimated developer value metric", async () => {
    await renderDashboard();

    expect(container?.textContent).toContain("Estimated Dev Value");
    expect(container?.textContent).toContain("$187.50");
    expect(container?.textContent).toContain("1.3h est. dev time");
    expect(container?.textContent).toContain("125.0k tokens");
    expect(container?.textContent).toContain("$186.25 saved");
  });

  it("renders the Codex project estimate as a non-spend estimate with its model basis", async () => {
    await renderDashboard();

    expect(container?.textContent).toContain("Codex Project Estimate");
    expect(container?.textContent).toContain("$630.00");
    expect(container?.textContent).toContain("4 Codex projects");
    expect(container?.textContent).toContain("4.2h estimated project work");
    expect(container?.textContent).toContain("3.25 wk");
    expect(container?.textContent).toContain("420.0k");
    expect(container?.textContent).toContain("not billed spend");
    expect(container?.textContent).toContain("$150.00/hr");
    expect(container?.textContent).toContain("100.0k tokens of work");
  });

  it("renders OpenRouter month-to-date spend when biller usage exists", async () => {
    costsApiMock.byBiller.mockResolvedValue([makeBillerUsageRow()]);

    await renderDashboard();

    expect(container?.textContent).toContain("OpenRouter Spend (MTD)");
    expect(container?.textContent).toContain("$12.34");
    expect(container?.textContent).toContain("2.0k tok");
    expect(container?.textContent).toContain("2 metered");
    expect(container?.textContent).toContain("1 subscription");
  });

  it("keeps the OpenRouter spend metric hidden when OpenRouter biller activity is absent", async () => {
    costsApiMock.byBiller.mockResolvedValue([makeBillerUsageRow({ biller: "openai" })]);

    await renderDashboard();

    expect(container?.textContent).not.toContain("OpenRouter Spend (MTD)");
  });

  it("renders the live Codex rate limits card when quota windows are available", async () => {
    costsApiMock.byProvider.mockResolvedValue([makeProviderUsageRow()]);
    costsApiMock.quotaWindows.mockResolvedValue([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [
          {
            label: "5h limit",
            usedPercent: 35,
            resetsAt: "2026-04-11T18:44:00.000Z",
            valueLabel: null,
            detail: null,
          },
          {
            label: "Weekly limit",
            usedPercent: 15,
            resetsAt: "2026-04-17T12:00:00.000Z",
            valueLabel: null,
            detail: null,
          },
          {
            label: "Credits",
            usedPercent: null,
            resetsAt: null,
            valueLabel: "$4.20 remaining",
            detail: null,
          },
        ],
      },
    ]);

    await renderDashboard();

    expect(container?.textContent).toContain("Rate limits remaining");
    expect(container?.textContent).toContain("5h");
    expect(container?.textContent).toContain("65%");
    expect(container?.textContent).toContain("Weekly");
    expect(container?.textContent).toContain("85%");
    expect(container?.textContent).toContain("$4.20 remaining");
    expect(container?.textContent).toContain("Codex app server");
  });

  it("shows an unavailable state when Codex usage exists but live quota polling fails", async () => {
    costsApiMock.byProvider.mockResolvedValue([makeProviderUsageRow()]);
    costsApiMock.quotaWindows.mockResolvedValue([
      {
        provider: "openai",
        ok: false,
        error: "ChatGPT WHAM usage: chatgpt wham api returned 401",
        windows: [],
      },
    ]);

    await renderDashboard();

    expect(container?.textContent).toContain("Rate limits remaining");
    expect(container?.textContent).toContain("Codex rate limits require a fresh ChatGPT login");
    expect(container?.textContent).not.toContain("chatgpt wham api returned 401");
    expect(container?.textContent).toContain("Open costs");
  });

  it("keeps the dashboard free of the limits card when there is no Codex usage or live data", async () => {
    costsApiMock.byProvider.mockResolvedValue([]);
    costsApiMock.quotaWindows.mockResolvedValue([]);

    await renderDashboard();

    expect(container?.textContent).not.toContain("Rate limits remaining");
  });
});
