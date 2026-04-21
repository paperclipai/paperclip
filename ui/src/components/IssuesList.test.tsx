// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const routerState = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

const kanbanBoardState = vi.hoisted(() => ({
  latestProps: null as null | {
    issueLinkState?: unknown;
    projects?: Array<{ id: string; name: string; code?: string | null }>;
  },
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => routerState.navigate,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./IssueRow", () => ({
  IssueRow: ({
    issue,
    assignedToCurrentUser,
    desktopMetaLeading,
    desktopTrailing,
    rowAction,
  }: {
    issue: Issue;
    assignedToCurrentUser?: boolean;
    desktopMetaLeading?: ReactNode;
    desktopTrailing?: ReactNode;
    rowAction?: ReactNode;
  }) => (
    <div data-testid="issue-row" data-assigned-to-current-user={assignedToCurrentUser ? "true" : undefined}>
      <span>{issue.title}</span>
      {desktopMetaLeading}
      {desktopTrailing}
      {rowAction}
    </div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KanbanBoard: (props: {
    issues: Issue[];
    issueLinkState?: unknown;
    projects?: Array<{ id: string; name: string; code?: string | null }>;
    onAddIssue?: (status: string) => void;
  }) => {
    kanbanBoardState.latestProps = props;
    return (
      <div data-testid="kanban-board">
        <button type="button" onClick={() => props.onAddIssue?.("in_progress")}>
          Add in progress
        </button>
        {props.issues.map((issue) => (
          <span key={issue.id}>{issue.title}</span>
        ))}
      </div>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let activeQueryClients: QueryClient[] = [];

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    boardPosition: 0,
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
    dueDate: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
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

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  activeQueryClients.push(queryClient);

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {node}
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("IssuesList", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    activeQueryClients = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    routerState.navigate.mockReset();
    kanbanBoardState.latestProps = null;
    dialogState.openNewIssue.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    localStorage.clear();
  });

  afterEach(() => {
    for (const queryClient of activeQueryClients) {
      queryClient.clear();
    }
    activeQueryClients = [];
    vi.useRealTimers();
    container.remove();
  });

  it("renders the Kanban board by default when no saved view state exists", async () => {
    const issue = createIssue({ title: "Default board issue" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[issue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="kanban-board"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="issue-row"]')).toBeNull();
      expect(container.textContent).toContain("Default board issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders top content above the Kanban board", async () => {
    const issue = createIssue({ title: "Board issue below top content" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[issue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        topContent={<div data-testid="project-top-content">Project rail</div>}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const topContent = container.querySelector('[data-testid="project-top-content"]');
      const board = container.querySelector('[data-testid="kanban-board"]');
      expect(topContent).not.toBeNull();
      expect(board).not.toBeNull();
      expect(topContent!.compareDocumentPosition(board!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    act(() => {
      root.unmount();
    });
  });

  it("forwards issue detail source state to the Kanban board", async () => {
    const issueLinkState = {
      issueDetailBreadcrumb: { label: "Paperclip App", href: "/projects/paperclip-app/issues" },
      issueDetailSource: "issues",
    } as const;

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ title: "Project board task" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        issueLinkState={issueLinkState}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(kanbanBoardState.latestProps?.issueLinkState).toBe(issueLinkState);
    });

    act(() => {
      root.unmount();
    });
  });

  it("forwards project metadata to the Kanban board", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ title: "Project board task", projectId: "project-papa" })]}
        agents={[]}
        projects={[{ id: "project-papa", name: "PC - Trello board", code: "PAPA" }]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(kanbanBoardState.latestProps?.projects).toEqual([
        { id: "project-papa", name: "PC - Trello board", code: "PAPA" },
      ]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("orders board tasks by manual board position", async () => {
    const laterActivity = createIssue({
      id: "issue-later-activity",
      title: "Later activity",
      boardPosition: 2,
      updatedAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const firstOnBoard = createIssue({
      id: "issue-first-on-board",
      title: "First on board",
      boardPosition: 0,
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[laterActivity, firstOnBoard]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const boardText = container.querySelector('[data-testid="kanban-board"]')?.textContent ?? "";
      expect(boardText.indexOf("First on board")).toBeLessThan(boardText.indexOf("Later activity"));
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps a saved list view preference", async () => {
    localStorage.setItem("paperclip:test-issues:company-1", JSON.stringify({ viewMode: "list" }));

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ title: "Saved list issue" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="issue-row"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="kanban-board"]')).toBeNull();
      expect(container.textContent).toContain("Saved list issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("marks list rows assigned to the current board user", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "board-user" },
      user: { id: "board-user", email: null, name: null },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "mine", title: "Mine", assigneeUserId: "board-user" }),
          createIssue({ id: "theirs", title: "Theirs", assigneeUserId: "other-user" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="issue-row"]'));
      const mine = rows.find((row) => row.textContent?.includes("Mine"));
      const theirs = rows.find((row) => row.textContent?.includes("Theirs"));
      expect(mine?.getAttribute("data-assigned-to-current-user")).toBe("true");
      expect(theirs?.hasAttribute("data-assigned-to-current-user")).toBe(false);
    });

    act(() => {
      root.unmount();
    });
  });

  it("sorts list rows by due date with undated tasks last", async () => {
    localStorage.setItem("paperclip:test-issues:company-1", JSON.stringify({
      viewMode: "list",
      sortField: "due",
      sortDir: "asc",
    }));

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-undated", title: "No due date", dueDate: null }),
          createIssue({ id: "issue-later", title: "Later due date", dueDate: "2026-05-02" }),
          createIssue({ id: "issue-earlier", title: "Earlier due date", dueDate: "2026-05-01" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rowText = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.textContent ?? "");
      expect(rowText[0]).toContain("Earlier due date");
      expect(rowText[1]).toContain("Later due date");
      expect(rowText[2]).toContain("No due date");
    });

    act(() => {
      root.unmount();
    });
  });

  it("groups date-list rows by due date and uses the group date for new tasks", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-may-2", title: "May 2 task", dueDate: "2026-05-02" }),
          createIssue({ id: "issue-may-1", title: "May 1 task", dueDate: "2026-05-01" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-date-list"
        defaultViewMode="list"
        defaultViewStatePatch={{ groupBy: "dueDate", sortField: "due", sortDir: "asc" }}
        lockedGroupBy="dueDate"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("May 1");
      expect(container.textContent).toContain("May 2");
      const rowText = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.textContent ?? "");
      expect(rowText[0]).toContain("May 1 task");
      expect(rowText[1]).toContain("May 2 task");
    });

    await act(async () => {
      const addButton = container.querySelector('button[aria-label*="May 1"]');
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialogState.openNewIssue).toHaveBeenCalledWith({ dueDate: "2026-05-01" });

    act(() => {
      root.unmount();
    });
  });

  it("shows the empty state under the default board view", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No tasks match the current filters or search.");
      expect(container.querySelector('[data-testid="kanban-board"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("opens the new task dialog with the selected board column status", async () => {
    const issue = createIssue({ title: "Board issue" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[issue]}
        agents={[]}
        projects={[]}
        projectId="project-1"
        viewStateKey="paperclip:test-issues"
        defaultNewIssueValues={{ assigneeUserId: "board-user" }}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="kanban-board"]')).not.toBeNull();
    });

    await act(async () => {
      const addButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Add in progress",
      );
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialogState.openNewIssue).toHaveBeenCalledWith({
      assigneeUserId: "board-user",
      projectId: "project-1",
      status: "in_progress",
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders server search results instead of filtering the full issue list locally", async () => {
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });
    const serverIssue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });

    mockIssuesApi.list.mockResolvedValue([serverIssue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        limit: 200,
      });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps server search constrained by supplied issue filters", async () => {
    const blockedIssue = createIssue({
      id: "issue-blocked",
      identifier: "PAP-5",
      title: "Blocked server result",
      status: "blocked",
    });

    mockIssuesApi.list.mockResolvedValue([blockedIssue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-blockers"
        initialSearch="release"
        searchFilters={{ status: "blocked", participantAgentId: "agent-1" }}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "release",
        projectId: undefined,
        limit: 200,
        status: "blocked",
        participantAgentId: "agent-1",
      });
      expect(container.textContent).toContain("Blocked server result");
    }, 80);

    act(() => {
      root.unmount();
    });
  });

  it("debounces search updates so typing does not notify the page on every keystroke", async () => {
    vi.useFakeTimers();

    const onSearchChange = vi.fn();
    const localIssue = createIssue({ id: "issue-local", identifier: "PAP-1", title: "Local issue" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[localIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onSearchChange={onSearchChange}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    expect(valueSetter).toBeTypeOf("function");

    act(() => {
      if (!input || !valueSetter) return;
      valueSetter.call(input, "a");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      valueSetter.call(input, "ab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(249);
    });

    expect(onSearchChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith("ab");

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when search results hit the live search cap", async () => {
    const serverIssues = Array.from({ length: 200 }, (_, index) =>
      createIssue({
        id: `issue-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Server result ${index + 1}`,
      }),
    );

    mockIssuesApi.list.mockResolvedValue(serverIssues);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Showing up to 200 matches. Refine the search to narrow further.");
    }, 80);

    act(() => {
      root.unmount();
    });
  });

  it("caps the first paint for large issue lists", async () => {
    vi.useFakeTimers();
    const manyIssues = Array.from({ length: 220 }, (_, index) =>
      createIssue({
        id: `issue-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Issue ${index + 1}`,
      }),
    );

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={manyIssues}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="issue-row"]')).toHaveLength(150);
      expect(container.textContent).toContain("Rendering 150 of 220 issues");
    });

    act(() => {
      root.unmount();
    });
  });

  it("skips deferred row sizing for expanded parent rows with visible children", async () => {
    const parentIssue = createIssue({
      id: "issue-parent",
      identifier: "PAP-1",
      title: "Parent issue",
    });
    const childIssue = createIssue({
      id: "issue-child",
      identifier: "PAP-2",
      title: "Child issue",
      parentId: "issue-parent",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[parentIssue, childIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="issue-row"]'));
      const parentRow = rows.find((row) => row.textContent?.includes("Parent issue"));
      const childRow = rows.find((row) => row.textContent?.includes("Child issue"));
      expect(parentRow).not.toBeUndefined();
      expect(childRow).not.toBeUndefined();
      expect((parentRow?.parentElement as HTMLDivElement | null)?.style.contentVisibility).toBe("");
      expect((parentRow?.parentElement as HTMLDivElement | null)?.style.containIntrinsicSize).toBe("");
      expect((childRow?.parentElement as HTMLDivElement | null)?.style.contentVisibility).toBe("auto");
      expect((childRow?.parentElement as HTMLDivElement | null)?.style.containIntrinsicSize).toBe("44px");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses context-scoped persisted column visibility", async () => {
    localStorage.setItem("paperclip:test-issues:company-1:issue-columns", JSON.stringify(["id", "assignee"]));

    const assignedIssue = createIssue({
      id: "issue-assigned",
      identifier: "PAP-9",
      title: "Assigned issue",
      assigneeAgentId: "agent-1",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[assignedIssue]}
        agents={[{ id: "agent-1", name: "Agent One" }]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const columnsButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Columns",
      );
      expect(columnsButton).not.toBeUndefined();
      expect(container.textContent).toContain("PAP-9");
      expect(container.textContent).toContain("Agent One");
      expect(container.textContent).not.toContain("Updated");
    });

    act(() => {
      root.unmount();
    });
  });

  it("preserves stored grouping across refresh when initial assignees are applied", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "list", groupBy: "status", sortField: "updated", sortDir: "desc" }),
    );

    const todoIssue = createIssue({ id: "issue-todo", title: "Alpha", status: "todo", assigneeAgentId: "agent-1" });
    const doneIssue = createIssue({ id: "issue-done", title: "Beta", status: "done", assigneeAgentId: "agent-1" });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[todoIssue, doneIssue]}
        agents={[{ id: "agent-1", name: "Agent One" }]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialAssignees={["agent-1"]}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Todo");
      expect(container.textContent).toContain("Done");
      expect(container.textContent).toContain("Alpha");
      expect(container.textContent).toContain("Beta");
    });

    act(() => {
      root.unmount();
    });
  });

  it("filters the list to a single workspace when a workspace name is clicked", async () => {
    localStorage.setItem("paperclip:test-issues:company-1:issue-columns", JSON.stringify(["id", "workspace"]));
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-alpha",
        name: "Alpha",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
      {
        id: "workspace-beta",
        name: "Beta",
        mode: "isolated_workspace",
        status: "active",
        projectWorkspaceId: null,
      },
    ]);

    const alphaIssue = createIssue({
      id: "issue-alpha",
      identifier: "PAP-20",
      title: "Alpha issue",
      executionWorkspaceId: "workspace-alpha",
      projectWorkspaceId: "workspace-alpha",
    });
    const betaIssue = createIssue({
      id: "issue-beta",
      identifier: "PAP-21",
      title: "Beta issue",
      executionWorkspaceId: "workspace-beta",
      projectWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[alphaIssue, betaIssue]}
        agents={[]}
        projects={[{
          id: "project-1",
          name: "Project One",
          color: null,
          workspaces: [
            { id: "workspace-alpha", name: "Alpha" },
            { id: "workspace-beta", name: "Beta" },
          ],
        } as any]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha issue");
      expect(container.textContent).toContain("Beta issue");
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      expect(workspaceButton).not.toBeUndefined();
    });

    await act(async () => {
      const workspaceButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Alpha",
      );
      workspaceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Alpha issue");
      expect(container.textContent).not.toContain("Beta issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows routine-backed issues by default and hides them when the routine filter is toggled off", async () => {
    const manualIssue = createIssue({
      id: "issue-manual",
      identifier: "PAP-10",
      title: "Manual issue",
      originKind: "manual",
    });
    const routineIssue = createIssue({
      id: "issue-routine",
      identifier: "PAP-11",
      title: "Routine issue",
      originKind: "routine_execution",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[manualIssue, routineIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableRoutineVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Manual issue");
      expect(container.textContent).toContain("Routine issue");
    });

    await act(async () => {
      const filterButton = Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.getAttribute("title") === "Filter",
      );
      filterButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      expect(toggle).not.toBeUndefined();
    });

    await act(async () => {
      const toggle = Array.from(document.body.querySelectorAll("label")).find(
        (label) => label.textContent?.includes("Hide routine runs"),
      );
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Routine issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Enter without clearing the query", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="bug"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("bug");

    act(() => {
      root.unmount();
    });
  });

  it("blurs the search input on Escape once the field is empty", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch=""
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search tasks"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }));
    });

    expect(document.activeElement).not.toBe(input);

    act(() => {
      root.unmount();
    });
  });

  it("shows an ask agents shortcut for open tasks assigned to the current user", async () => {
    localStorage.setItem("paperclip:test-issues:company-1", JSON.stringify({ viewMode: "list" }));
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "board-user" },
      user: { id: "board-user", email: null, name: null },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ assigneeUserId: "board-user" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        issueLinkState={{
          issueDetailBreadcrumb: { label: "My Tasks", href: "/my-issues" },
          issueDetailSource: "issues",
        }}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('button[title="Ask agents"]')).not.toBeNull();
    });

    await act(async () => {
      const askButton = container.querySelector('button[title="Ask agents"]');
      askButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(routerState.navigate).toHaveBeenCalledWith(
      "/issues/PAP-1?askAgents=1",
      expect.objectContaining({
        state: expect.objectContaining({
          issueDetailBreadcrumb: { label: "My Tasks", href: "/my-issues" },
          issueDetailHeaderSeed: expect.objectContaining({
            id: "issue-1",
            identifier: "PAP-1",
            title: "Issue title",
          }),
        }),
      }),
    );

    act(() => {
      root.unmount();
    });
  });

  it("hides the ask agents shortcut for terminal or non-owned tasks", async () => {
    localStorage.setItem("paperclip:test-issues:company-1", JSON.stringify({ viewMode: "list" }));
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "board-user" },
      user: { id: "board-user", email: null, name: null },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "done-issue", title: "Done issue", status: "done", assigneeUserId: "board-user" }),
          createIssue({ id: "other-issue", title: "Other issue", status: "todo", assigneeUserId: "other-user" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Done issue");
      expect(container.textContent).toContain("Other issue");
    });

    expect(container.querySelector('button[title="Ask agents"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("marks list rows assigned to visible company agents", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "board-user" },
      user: { id: "board-user", email: null, name: null },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "agent-work", title: "Agent work", assigneeAgentId: "agent-steward" }),
          createIssue({ id: "other-work", title: "Other work", assigneeAgentId: "agent-other" }),
        ]}
        agents={[{ id: "agent-steward", name: "Paperclip Steward" }]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultViewMode="list"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="issue-row"]'));
      const agentWork = rows.find((row) => row.textContent?.includes("Agent work"));
      const otherWork = rows.find((row) => row.textContent?.includes("Other work"));
      expect(agentWork?.getAttribute("data-assigned-to-current-user")).toBe("true");
      expect(otherWork?.hasAttribute("data-assigned-to-current-user")).toBe(false);
    });

    act(() => {
      root.unmount();
    });
  });
});
