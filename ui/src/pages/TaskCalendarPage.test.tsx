// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCalendarPage } from "./TaskCalendarPage";
import { formatDateOnly } from "../lib/issue-date-ranges";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  searchParams: new URLSearchParams(""),
}));

const issuesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const authApiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: {
    to: string;
    children: ReactNode;
    disableIssueQuicklook?: boolean;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => [routerState.searchParams, vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: issuesApiMock,
}));

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("../api/auth", () => ({
  authApi: authApiMock,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Calendar task",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    dueDate: formatDateOnly(),
    createdAt: new Date("2026-04-20T12:00:00.000Z"),
    updatedAt: new Date("2026-04-20T12:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
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

async function renderCalendar() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TaskCalendarPage />
      </QueryClientProvider>,
    );
  });

  return { container, root };
}

describe("TaskCalendarPage", () => {
  let container: HTMLDivElement | null;
  let root: Root | null;

  beforeEach(() => {
    window.localStorage.clear();
    routerState.searchParams = new URLSearchParams("");
    companyState.selectedCompanyId = "company-1";
    breadcrumbState.setBreadcrumbs.mockReset();
    toastState.pushToast.mockReset();
    issuesApiMock.list.mockReset();
    issuesApiMock.update.mockReset();
    agentsApiMock.list.mockReset();
    authApiMock.getSession.mockReset();
    agentsApiMock.list.mockResolvedValue([]);
    authApiMock.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "board-user" },
      user: { id: "board-user", email: null, name: null },
    });
    container = null;
    root = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    vi.clearAllMocks();
  });

  it("highlights calendar tasks assigned to the current user", async () => {
    issuesApiMock.list.mockResolvedValue([
      createIssue({ id: "issue-mine", title: "Mine", assigneeUserId: "board-user" }),
      createIssue({ id: "issue-other", title: "Other", assigneeUserId: "other-user" }),
    ]);

    ({ container, root } = await renderCalendar());

    await waitForAssertion(() => {
      expect(container?.textContent).toContain("Mine");
    });

    const highlightedTasks = Array.from(container!.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedTasks).toHaveLength(2);
    expect(highlightedTasks.every((task) => task.textContent?.includes("Mine"))).toBe(true);
    expect(highlightedTasks[0]?.className).toContain("border-l-4");
    expect(highlightedTasks[0]?.className).toContain("bg-cyan-500");
  });

  it("highlights calendar tasks assigned to visible company agents", async () => {
    agentsApiMock.list.mockResolvedValue([{ id: "agent-steward", name: "Paperclip Steward" }]);
    issuesApiMock.list.mockResolvedValue([
      createIssue({ id: "issue-agent", title: "Agent work", assigneeAgentId: "agent-steward" }),
      createIssue({ id: "issue-other", title: "Other work", assigneeAgentId: "agent-other" }),
    ]);

    ({ container, root } = await renderCalendar());

    await waitForAssertion(() => {
      expect(container?.textContent).toContain("Agent work");
    });

    const highlightedTasks = Array.from(container!.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedTasks).toHaveLength(2);
    expect(highlightedTasks.every((task) => task.textContent?.includes("Agent work"))).toBe(true);
    expect(highlightedTasks[0]?.className).toContain("border-l-4");
  });
});
