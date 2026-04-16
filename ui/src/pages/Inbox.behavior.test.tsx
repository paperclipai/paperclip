// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "./Inbox";

const navigateState = vi.hoisted(() => ({
  fn: vi.fn(),
}));

const locationState = vi.hoisted(() => ({
  pathname: "/inbox/unread",
  search: "",
  hash: "",
}));

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const generalSettingsState = vi.hoisted(() => ({
  keyboardShortcutsEnabled: false,
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  wakeup: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockApprovalsApi = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listJoinRequests: vi.fn(),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
}));

const mockDashboardApi = vi.hoisted(() => ({
  summary: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  archiveFromInbox: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
  useLocation: () => locationState,
  useNavigate: () => navigateState.fn,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => generalSettingsState,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: mockApprovalsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>loading</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/IssueRow", () => ({
  IssueRow: () => <div>Issue row</div>,
}));

vi.mock("../components/SwipeToArchive", () => ({
  SwipeToArchive: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({ items }: { items: Array<{ value: string; label: string }> }) => (
    <div>{items.map((item) => <span key={item.value}>{item.label}</span>)}</div>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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

function renderInbox(container: HTMLDivElement) {
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
        <Inbox />
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("Inbox retry behavior", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Element.prototype.scrollIntoView = vi.fn();
    window.localStorage.clear();

    navigateState.fn.mockReset();
    breadcrumbsState.setBreadcrumbs.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAgentsApi.list.mockReset();
    mockAgentsApi.wakeup.mockReset();
    mockProjectsApi.list.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockApprovalsApi.list.mockReset();
    mockAccessApi.listJoinRequests.mockReset();
    mockDashboardApi.summary.mockReset();
    mockIssuesApi.list.mockReset();
    mockHeartbeatsApi.list.mockReset();
    mockHeartbeatsApi.get.mockReset();

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { userId: "user-1" } });
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "QA and Release Engineer" }]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockApprovalsApi.list.mockResolvedValue([]);
    mockAccessApi.listJoinRequests.mockResolvedValue([]);
    mockDashboardApi.summary.mockResolvedValue({
      companyId: "company-1",
      agents: { active: 1, running: 0, paused: 0, error: 0 },
      tasks: { open: 0, inProgress: 0, blocked: 0, done: 0 },
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
      budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
      brief: {
        health: "healthy",
        snapshot: {
          progress: { value: "0", label: "In flight", headline: "Quiet", detail: "No active work", tone: "healthy" },
          risk: { value: "0", label: "Blocked", headline: "Quiet", detail: "No blocked work", tone: "healthy" },
          decisions: { value: "0", label: "Waiting", headline: "Quiet", detail: "Nothing waiting", tone: "healthy" },
          spend: { value: "$0", label: "Month spend", headline: "Quiet", detail: "No spend", tone: "healthy" },
        },
        focusAreas: [],
        needsAttention: [],
      },
    });
    mockIssuesApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.list.mockResolvedValue([
      {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        invocationSource: "assignment",
        triggerDetail: null,
        status: "failed",
        error: "Adapter failed",
        wakeupRequestId: null,
        exitCode: null,
        signal: null,
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        errorCode: null,
        externalRunId: null,
        processPid: null,
        processStartedAt: null,
        retryOfRunId: null,
        retryGroupId: null,
        retryAttempt: 0,
        retryState: "none",
        retryClass: null,
        retryScheduledFor: null,
        retryExhaustedAt: null,
        retryBlockedReason: null,
        retryLastDecision: null,
        retryPolicyJson: null,
        processLossRetryCount: 0,
        contextSnapshot: null,
        startedAt: new Date("2026-04-15T12:00:00.000Z"),
        finishedAt: new Date("2026-04-15T12:01:00.000Z"),
        createdAt: new Date("2026-04-15T12:00:00.000Z"),
        updatedAt: new Date("2026-04-15T12:01:00.000Z"),
      },
    ]);
    mockHeartbeatsApi.get.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      invocationSource: "assignment",
      triggerDetail: null,
      status: "failed",
      error: "Adapter failed",
      wakeupRequestId: null,
      exitCode: null,
      signal: null,
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: null,
      stderrExcerpt: "model access denied",
      errorCode: null,
      externalRunId: null,
      processPid: null,
      processStartedAt: null,
      retryOfRunId: null,
      retryGroupId: null,
      retryAttempt: 0,
      retryState: "none",
      retryClass: null,
      retryScheduledFor: null,
      retryExhaustedAt: null,
      retryBlockedReason: null,
      retryLastDecision: null,
      retryPolicyJson: null,
      processLossRetryCount: 0,
      contextSnapshot: null,
      startedAt: new Date("2026-04-15T12:00:00.000Z"),
      finishedAt: new Date("2026-04-15T12:01:00.000Z"),
      createdAt: new Date("2026-04-15T12:00:00.000Z"),
      updatedAt: new Date("2026-04-15T12:01:00.000Z"),
    });
    mockAgentsApi.wakeup.mockResolvedValue({
      id: "run-2",
      companyId: "company-1",
      agentId: "agent-1",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "queued",
      error: null,
      wakeupRequestId: null,
      exitCode: null,
      signal: null,
      usageJson: null,
      resultJson: null,
      sessionIdBefore: null,
      sessionIdAfter: null,
      logStore: null,
      logRef: null,
      logBytes: null,
      logSha256: null,
      logCompressed: false,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      errorCode: null,
      externalRunId: null,
      processPid: null,
      processStartedAt: null,
      retryOfRunId: null,
      retryGroupId: null,
      retryAttempt: 0,
      retryState: "none",
      retryClass: null,
      retryScheduledFor: null,
      retryExhaustedAt: null,
      retryBlockedReason: null,
      retryLastDecision: null,
      retryPolicyJson: null,
      processLossRetryCount: 0,
      contextSnapshot: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date("2026-04-15T12:02:00.000Z"),
      updatedAt: new Date("2026-04-15T12:02:00.000Z"),
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("retries a failed run without navigating away from the inbox", async () => {
    const { root } = renderInbox(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Retry");
    });

    const retryButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retryButton).toBeTruthy();

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockAgentsApi.wakeup).toHaveBeenCalledTimes(1);
    });

    expect(navigateState.fn).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("hides read failed runs from the unread tab", async () => {
    window.localStorage.setItem("paperclip:inbox:read-items", JSON.stringify(["run:run-1"]));
    const { root } = renderInbox(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No unread updates.");
    });

    expect(container.textContent).not.toContain("Retry");
    expect(container.textContent).not.toContain("QA and Release Engineer");

    act(() => {
      root.unmount();
    });
  });
});
