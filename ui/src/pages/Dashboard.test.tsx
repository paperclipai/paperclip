// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const apiMocks = vi.hoisted(() => ({
  dashboardSummary: vi.fn(),
  activityList: vi.fn(),
  accessDirectory: vi.fn(),
  issuesList: vi.fn(),
  issuesAddComment: vi.fn(),
  issuesAcceptInteraction: vi.fn(),
  issuesRejectInteraction: vi.fn(),
  agentsList: vi.fn(),
  projectsList: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a className={className} href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: apiMocks.dashboardSummary },
}));

vi.mock("../api/activity", () => ({
  activityApi: { list: apiMocks.activityList },
}));

vi.mock("../api/access", () => ({
  accessApi: { listUserDirectory: apiMocks.accessDirectory },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: apiMocks.issuesList,
    addComment: apiMocks.issuesAddComment,
    acceptInteraction: apiMocks.issuesAcceptInteraction,
    rejectInteraction: apiMocks.issuesRejectInteraction,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: apiMocks.projectsList },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    companies: [{ id: "company-1", name: "Paperclip" }],
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

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function dashboardSummary(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "company-1",
    agents: { active: 0, running: 0, paused: 0, error: 0 },
    tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
    costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
    pendingApprovals: 0,
    pendingBoardConfirmations: [],
    budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
    runActivity: [],
    ...overrides,
  };
}

async function renderDashboard(container: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });

  return root;
}

describe("Dashboard Board Inbox", () => {
  let container: HTMLDivElement;
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-05-28T10:00:00.000Z").getTime());
    container = document.createElement("div");
    document.body.appendChild(container);
    apiMocks.activityList.mockResolvedValue([]);
    apiMocks.accessDirectory.mockResolvedValue({ users: [] });
    apiMocks.issuesList.mockResolvedValue([]);
    apiMocks.issuesAddComment.mockResolvedValue({});
    apiMocks.issuesAcceptInteraction.mockResolvedValue({});
    apiMocks.issuesRejectInteraction.mockResolvedValue({});
    apiMocks.agentsList.mockResolvedValue([]);
    apiMocks.projectsList.mockResolvedValue([]);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    container.remove();
  });

  it("renders pending board confirmations from the dashboard DTO", async () => {
    apiMocks.dashboardSummary.mockResolvedValue(dashboardSummary({
      pendingApprovals: 1,
      pendingBoardConfirmations: [
        {
          id: "interaction-1",
          issueIdentifier: "PAP-123",
          title: "Approve source release",
          summary: "Ship the Board Inbox source patch.",
          createdAt: "2026-05-28T08:30:00.000Z",
          createdByAgentName: "Planner",
        },
      ],
    }));

    const root = await renderDashboard(container);

    expect(container.textContent).toContain("Board Inbox");
    expect(container.textContent).toContain("PAP-123");
    expect(container.textContent).toContain("Approve source release");
    expect(container.textContent).toContain("Ship the Board Inbox source patch.");
    expect(container.textContent).toContain("Planner");
    expect(container.textContent).toContain("1 board confirmations awaiting response");

    const link = container.querySelector<HTMLAnchorElement>('a[href="/issues/PAP-123#interaction-interaction-1"]');
    expect(link).not.toBeNull();
    expect(link?.closest("[data-board-confirmation-card]")?.className).toContain("border-amber-500/50");
    expect(Array.from(container.querySelectorAll("button")).map((button) => button.textContent)).toEqual(
      expect.arrayContaining(["Approve", "Reject", "Comment"]),
    );

    act(() => {
      root.unmount();
    });
  });

  it("posts comments directly to the issue thread and shows failures inline", async () => {
    apiMocks.dashboardSummary.mockResolvedValue(dashboardSummary({
      pendingBoardConfirmations: [
        {
          id: "interaction-1",
          issueIdentifier: "PAP-123",
          title: "Approve source release",
          summary: null,
          createdAt: "2026-05-28T09:45:00.000Z",
          createdByAgentName: null,
        },
      ],
    }));
    apiMocks.issuesAddComment.mockRejectedValueOnce(new Error("network down"));

    const root = await renderDashboard(container);
    const commentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Comment");

    await act(async () => {
      commentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(apiMocks.issuesAddComment).toHaveBeenCalledWith(
      "PAP-123",
      "Board Inbox comment requested for pending confirmation interaction-1.",
    );
    expect(container.textContent).toContain("Comment failed to post.");

    act(() => {
      root.unmount();
    });
  });
});
