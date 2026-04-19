// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Blockers } from "./Issues";
import { MyIssues } from "./MyIssues";
import { Next7DayTasks, TodayTasks } from "./TaskDateListPage";
import { addDays, formatDateOnly } from "../lib/issue-date-ranges";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  pathname: "/blockers",
  search: "?q=release&participantAgentId=agent-1",
  hash: "",
}));

const issuesListState = vi.hoisted(() => ({
  latestProps: null as null | Record<string, unknown>,
}));

const issuesApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const heartbeatsApiMock = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const authApiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => routerState,
  useSearchParams: () => [new URLSearchParams(routerState.search), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
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

vi.mock("../api/auth", () => ({
  authApi: authApiMock,
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: Record<string, unknown>) => {
    issuesListState.latestProps = props;
    return <div data-testid="issues-list" />;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

async function renderBlockers() {
  await renderPage(<Blockers />);
}

async function renderMyIssues() {
  await renderPage(<MyIssues />);
}

async function renderTodayTasks() {
  await renderPage(<TodayTasks />);
}

async function renderNext7Tasks() {
  await renderPage(<Next7DayTasks />);
}

async function renderPage(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  routerState.pathname = "/blockers";
  routerState.search = "?q=release&participantAgentId=agent-1";
  routerState.hash = "";
  issuesListState.latestProps = null;
  breadcrumbState.setBreadcrumbs.mockReset();
  issuesApiMock.list.mockReset();
  issuesApiMock.update.mockReset();
  agentsApiMock.list.mockReset();
  projectsApiMock.list.mockReset();
  heartbeatsApiMock.liveRunsForCompany.mockReset();
  authApiMock.getSession.mockReset();
  issuesApiMock.list.mockResolvedValue([]);
  agentsApiMock.list.mockResolvedValue([]);
  projectsApiMock.list.mockResolvedValue([]);
  heartbeatsApiMock.liveRunsForCompany.mockResolvedValue([]);
  authApiMock.getSession.mockResolvedValue({
    session: { id: "session-1", userId: "board-user" },
    user: { id: "board-user", email: null, name: null },
  });
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

describe("Blockers page", () => {
  it("loads and searches only blocked non-routine issues", async () => {
    await renderBlockers();

    await waitForAssertion(() => {
      expect(issuesApiMock.list).toHaveBeenCalledWith("company-1", {
        participantAgentId: "agent-1",
        status: "blocked",
        includeRoutineExecutions: false,
      });
      expect(issuesListState.latestProps).not.toBeNull();
    });

    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Blockers" }]);
    expect(issuesListState.latestProps).toEqual(expect.objectContaining({
      viewStateKey: "paperclip:blockers-view",
      initialSearch: "release",
      enableRoutineVisibilityFilter: false,
      searchFilters: {
        participantAgentId: "agent-1",
        status: "blocked",
      },
    }));
  });
});

describe("MyIssues page", () => {
  it("loads the saved My Tasks board from the current board assignee filter", async () => {
    routerState.pathname = "/my-issues";
    routerState.search = "?q=handoff";

    await renderMyIssues();

    await waitForAssertion(() => {
      expect(issuesApiMock.list).toHaveBeenCalledWith("company-1", {
        assigneeUserId: "me",
      });
      expect(issuesListState.latestProps).toEqual(expect.objectContaining({
        viewStateKey: "paperclip:my-issues-view",
        initialSearch: "handoff",
        searchFilters: {
          assigneeUserId: "me",
        },
        defaultNewIssueValues: {
          assigneeUserId: "board-user",
        },
        emptyMessage: "No tasks assigned to you.",
      }));
    });

    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "My Tasks" }]);
  });
});

describe("Task date pages", () => {
  it("loads today's tasks with the My scope and date defaults", async () => {
    routerState.pathname = "/tasks/today";
    routerState.search = "?scope=my&q=launch";
    const today = formatDateOnly();

    await renderTodayTasks();

    await waitForAssertion(() => {
      expect(issuesApiMock.list).toHaveBeenCalledWith("company-1", {
        status: "backlog,todo,in_progress,in_review,blocked",
        dueDate: today,
        assigneeUserId: "me",
      });
      expect(issuesListState.latestProps).toEqual(expect.objectContaining({
        viewStateKey: "paperclip:tasks:today",
        defaultViewMode: "list",
        lockedViewMode: "list",
        initialSearch: "launch",
        searchFilters: {
          status: "backlog,todo,in_progress,in_review,blocked",
          dueDate: today,
          assigneeUserId: "me",
        },
        defaultNewIssueValues: {
          dueDate: today,
        },
      }));
    });

    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Today" }]);
  });

  it("loads Next 7 Days tasks grouped by due date", async () => {
    routerState.pathname = "/tasks/next-7-days";
    routerState.search = "";
    const today = formatDateOnly();

    await renderNext7Tasks();

    await waitForAssertion(() => {
      expect(issuesApiMock.list).toHaveBeenCalledWith("company-1", {
        status: "backlog,todo,in_progress,in_review,blocked",
        dueFrom: today,
        dueTo: addDays(today, 6),
      });
      expect(issuesListState.latestProps).toEqual(expect.objectContaining({
        viewStateKey: "paperclip:tasks:next7",
        defaultViewMode: "list",
        lockedViewMode: "list",
        lockedGroupBy: "dueDate",
        searchFilters: {
          status: "backlog,todo,in_progress,in_review,blocked",
          dueFrom: today,
          dueTo: addDays(today, 6),
        },
      }));
    });

    expect(breadcrumbState.setBreadcrumbs).toHaveBeenCalledWith([{ label: "Next 7 Days" }]);
  });
});
