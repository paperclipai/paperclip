// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const getCurrentBoardAccessMock = vi.hoisted(() => vi.fn());
const getAgentQueuedCountsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    to,
  }: {
    children: ReactNode;
    className?: string;
    to: string;
  }) => (
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: {
    summary: vi.fn().mockResolvedValue({
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      budgets: {
        activeIncidents: 0,
        pausedAgents: 0,
        pausedProjects: 0,
        pendingApprovals: 0,
      },
      costs: {
        monthBudgetCents: 0,
        monthSpendCents: 0,
        monthUtilizationPercent: 0,
      },
      pendingApprovals: 0,
      runActivity: [],
      tasks: { blocked: 0, inProgress: 0, open: 0 },
    }),
  },
}));

vi.mock("../api/activity", () => ({
  activityApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    getCurrentBoardAccess: () => getCurrentBoardAccessMock(),
    listUserDirectory: vi.fn().mockResolvedValue({ users: [] }),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue([
      {
        id: "agent-1",
        name: "Coder",
        status: "active",
      },
    ]),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    getAgentQueuedCounts: () => getAgentQueuedCountsMock(),
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: vi.fn() }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../components/ActiveAgentsPanel", () => ({
  ActiveAgentsPanel: () => <div data-testid="active-agents-panel" />,
}));

vi.mock("../components/ActivityCharts", () => ({
  ChartCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  IssueStatusChart: () => <div />,
  PriorityChart: () => <div />,
  RunActivityChart: () => <div />,
  SuccessRateChart: () => <div />,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderDashboard(container: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>,
    );
  });

  return { queryClient, root };
}

describe("Dashboard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getAgentQueuedCountsMock.mockResolvedValue([{ agentId: "agent-1", queuedCount: 3 }]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides queued run metrics and skips the admin query for non-admin board users", async () => {
    getCurrentBoardAccessMock.mockResolvedValue({ isInstanceAdmin: false });
    const { queryClient, root } = await renderDashboard(container);

    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Queued Runs");
    expect(getAgentQueuedCountsMock).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      queryClient.clear();
    });
  });

  it("shows queued run metrics for instance admins", async () => {
    getCurrentBoardAccessMock.mockResolvedValue({ isInstanceAdmin: true });
    const { queryClient, root } = await renderDashboard(container);

    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Queued Runs");
    expect(container.textContent).toContain("3");
    expect(getAgentQueuedCountsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      queryClient.clear();
    });
  });
});
