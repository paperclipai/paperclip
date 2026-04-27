// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesList } from "./IssuesList";
import { TooltipProvider } from "@/components/ui/tooltip";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listLabels: vi.fn(),
}));

const mockKanbanBoard = vi.hoisted(() => vi.fn());

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
  listUserDirectory: vi.fn(),
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
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
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
    desktopMetaLeading,
    desktopTrailing,
    titleClassName,
    checklistStepNumber,
    checklistCurrentStep,
    checklistDependencyChips,
    checklistRowId,
  }: {
    issue: Issue;
    desktopMetaLeading?: ReactNode;
    desktopTrailing?: ReactNode;
    titleClassName?: string;
    checklistStepNumber?: number | string | null;
    checklistCurrentStep?: boolean;
    checklistDependencyChips?: ReactNode;
    checklistRowId?: string;
  }) => (
    <div
      data-testid="issue-row"
      id={checklistRowId}
      data-step={checklistStepNumber ?? undefined}
      data-current-step={checklistCurrentStep ? "true" : undefined}
      data-title-class={titleClassName ?? undefined}
    >
      <span>{issue.title}</span>
      {desktopMetaLeading}
      {desktopTrailing}
      {checklistDependencyChips}
    </div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KanbanBoard: (props: { issues: Issue[] }) => {
    mockKanbanBoard(props);
    return (
      <div data-testid="kanban-board">
        {props.issues.map((issue) => (
          <span key={issue.id}>{issue.title}</span>
        ))}
      </div>
    );
  },
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
    title: "Issue title",
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

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await Promise.resolve();
      });
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
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.openNewIssue.mockReset();
    mockKanbanBoard.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockAccessApi.listMembers.mockReset();
    mockAccessApi.listUserDirectory.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockInstanceSettingsApi.getExperimental.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockAccessApi.listMembers.mockResolvedValue({ members: [], access: {} });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
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

  it("keeps server-side search scoped to the provided parent issue filters", async () => {
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
        searchFilters={{ parentId: "parent-1" }}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
        q: "server",
        projectId: undefined,
        parentId: "parent-1",
        limit: 200,
      });
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses the supplied create defaults and label for sub-issue lists", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        baseCreateIssueDefaults={{ parentId: "parent-1", projectId: "project-1" }}
        createIssueLabel="Sub-issue"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-issue"),
      );
      expect(button).not.toBeUndefined();
    });

    await act(async () => {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("New Sub-issue"),
      );
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(dialogState.openNewIssue).toHaveBeenCalledWith({
      parentId: "parent-1",
      projectId: "project-1",
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders the opt-in sub-issue progress summary with workflow next-up linking", async () => {
    const doneIssue = createIssue({
      id: "issue-done",
      identifier: "PAP-1",
      title: "Completed setup",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const nextIssue = createIssue({
      id: "issue-next",
      identifier: "PAP-2",
      title: "Implement next slice",
      status: "todo",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
      blockedBy: [{
        id: "issue-done",
        identifier: "PAP-1",
        title: "Completed setup",
        status: "done",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      }],
    });
    const blockedIssue = createIssue({
      id: "issue-blocked",
      identifier: "PAP-3",
      title: "Blocked follow-up",
      status: "blocked",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const cancelledIssue = createIssue({
      id: "issue-cancelled",
      identifier: "PAP-4",
      title: "Cancelled follow-up",
      status: "cancelled",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[cancelledIssue, blockedIssue, nextIssue, doneIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const progress = container.querySelector('[role="progressbar"]');
      expect(progress).not.toBeNull();
      expect(progress?.getAttribute("aria-valuenow")).toBe("1");
      expect(progress?.getAttribute("aria-valuemax")).toBe("3");
      expect(container.textContent).toContain("1/3 done");
      expect(container.textContent).toContain("0 in progress");
      expect(container.textContent).toContain("1 blocked");
      expect(container.textContent).not.toContain("Done 1");
      expect(container.textContent).toContain("Next up");
      const link = container.querySelector('a[href="/issues/PAP-2"]');
      expect(link?.textContent).toContain("Implement next slice");
      expect(container.querySelector('[title="Cancelled: 1"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("adds checklist affordances for workflow-sorted sub-issue lists", async () => {
    const issueDone = createIssue({
      id: "issue-done",
      identifier: "PAP-1",
      title: "Done first",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const issueBlocked = createIssue({
      id: "issue-blocked",
      identifier: "PAP-2",
      title: "Blocked issue",
      status: "blocked",
      blockedBy: [{ id: "issue-active", identifier: "PAP-3", title: "Active blocker", status: "todo", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const issueActive = createIssue({
      id: "issue-active",
      identifier: "PAP-3",
      title: "Active blocker",
      status: "todo",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[issueBlocked, issueActive, issueDone]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultSortField="workflow"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="issue-row"]'));
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.getAttribute("data-step"))).toEqual(["1", "2", "3"]);
      expect(container.textContent?.replace(/\s+/g, "")).toContain("1.PAP-1");
      expect(container.textContent?.replace(/\s+/g, "")).toContain("2.PAP-3");
      expect(rows.filter((row) => row.getAttribute("data-current-step") === "true")).toHaveLength(1);
      expect(rows.find((row) => row.textContent?.includes("Active blocker"))?.getAttribute("data-current-step")).toBe("true");
      expect(rows.find((row) => row.textContent?.includes("Done first"))?.getAttribute("data-title-class")).toContain("text-muted-foreground");
      expect(container.textContent).toContain("blocked by PAP-3 · step 2");
    });

    act(() => {
      root.unmount();
    });
  });

  it("uses hierarchical checklist step numbers when nested rows render inline", async () => {
    const firstRoot = createIssue({
      id: "issue-first-root",
      identifier: "PAP-1",
      title: "First root",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const parent = createIssue({
      id: "issue-parent",
      identifier: "PAP-2",
      title: "Parent slice",
      status: "todo",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const nextRoot = createIssue({
      id: "issue-next-root",
      identifier: "PAP-3",
      title: "Next root",
      status: "todo",
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const grandchild = createIssue({
      id: "issue-grandchild",
      identifier: "PAP-4",
      title: "Nested cancelled cleanup",
      status: "cancelled",
      parentId: "issue-parent",
      createdAt: new Date("2026-04-04T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[grandchild, nextRoot, firstRoot, parent]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultSortField="workflow"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const rows = Array.from(container.querySelectorAll('[data-testid="issue-row"]'));
      expect(rows).toHaveLength(4);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining("First root"),
        expect.stringContaining("Parent slice"),
        expect.stringContaining("Nested cancelled cleanup"),
        expect.stringContaining("Next root"),
      ]);
      expect(rows.map((row) => row.getAttribute("data-step"))).toEqual(["1", "2", "2.1", "3"]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides the sub-issue progress summary unless it is enabled with multiple sub-issues", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelector('[role="progressbar"]')).toBeNull();
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows waiting on blockers when every remaining sub-issue is blocked", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({
            id: "issue-done",
            identifier: "PAP-1",
            title: "Completed setup",
            status: "done",
            createdAt: new Date("2026-04-01T00:00:00.000Z"),
          }),
          createIssue({
            id: "issue-blocked",
            identifier: "PAP-2",
            title: "Blocked follow-up",
            status: "blocked",
            createdAt: new Date("2026-04-02T00:00:00.000Z"),
          }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        showProgressSummary
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Waiting on blockers");
      const link = container.querySelector('a[href="/issues/PAP-2"]');
      expect(link?.textContent).toContain("Blocked follow-up");
    });

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

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
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

    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ statuses: ["done"] }),
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

    await waitForMicrotaskAssertion(() => {
      expect(container.textContent).toContain("Showing up to 200 matches. Refine the search to narrow further.");
    });

    act(() => {
      root.unmount();
    });
  }, 10_000);

  it("loads board issues with a separate result limit for each status column", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const parentIssue = createIssue({
      id: "issue-parent-total-limit",
      title: "Parent total-limited issue",
      status: "todo",
    });
    const backlogIssue = createIssue({
      id: "issue-backlog",
      title: "Backlog column issue",
      status: "backlog",
    });
    const doneIssue = createIssue({
      id: "issue-done",
      title: "Done column issue",
      status: "done",
    });

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve([backlogIssue]);
      if (filters?.status === "done") return Promise.resolve([doneIssue]);
      return Promise.resolve([]);
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[parentIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        enableRoutineVisibilityFilter
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "backlog",
        limit: 200,
        includeRoutineExecutions: true,
      }));
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
        status: "done",
        limit: 200,
        includeRoutineExecutions: true,
      }));
      expect(mockKanbanBoard).toHaveBeenLastCalledWith(expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ id: "issue-backlog" }),
          expect.objectContaining({ id: "issue-done" }),
        ]),
      }));
      expect(container.textContent).toContain("Backlog column issue");
      expect(container.textContent).toContain("Done column issue");
      expect(container.textContent).not.toContain("Parent total-limited issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows a refinement hint when a board column hits its server cap", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ viewMode: "board" }),
    );

    const cappedBacklogIssues = Array.from({ length: 200 }, (_, index) =>
      createIssue({
        id: `issue-backlog-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Backlog issue ${index + 1}`,
        status: "backlog",
      }),
    );

    mockIssuesApi.list.mockImplementation((_companyId, filters) => {
      if (filters?.status === "backlog") return Promise.resolve(cappedBacklogIssues);
      return Promise.resolve([]);
    });

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
      expect(container.textContent).toContain("Some board columns are showing up to 200 issues. Refine filters or search to reveal the rest.");
    });

    act(() => {
      root.unmount();
    });
  });

  it("caps the first paint for large issue lists", async () => {
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
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="issue-row"]')).toHaveLength(100);
      expect(container.textContent).toContain("Rendering 100 of 220 issues");
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

  it("shows human assignee names from company member profiles", async () => {
    localStorage.setItem("paperclip:test-issues:company-1:issue-columns", JSON.stringify(["id", "assignee"]));
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-2",
          status: "active",
          user: {
            id: "user-2",
            name: "Jordan Lee",
            email: "jordan@example.com",
            image: "https://example.com/jordan.png",
          },
        },
      ],
    });

    const assignedIssue = createIssue({
      id: "issue-human",
      identifier: "PAP-12",
      title: "Human assigned issue",
      assigneeUserId: "user-2",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[assignedIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Jordan Lee");
    });

    act(() => {
      root.unmount();
    });
  });

  it("preserves stored grouping across refresh when initial assignees are applied", async () => {
    localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({ groupBy: "status", sortField: "updated", sortDir: "desc" }),
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
    });
    const betaIssue = createIssue({
      id: "issue-beta",
      identifier: "PAP-21",
      title: "Beta issue",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[alphaIssue, betaIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
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

  it("applies an initial workspace filter from the issues URL state", async () => {
    const alphaIssue = createIssue({
      id: "issue-alpha",
      identifier: "PAP-30",
      title: "Alpha issue",
      executionWorkspaceId: "workspace-alpha",
    });
    const betaIssue = createIssue({
      id: "issue-beta",
      identifier: "PAP-31",
      title: "Beta issue",
      executionWorkspaceId: "workspace-beta",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[alphaIssue, betaIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialWorkspaces={["workspace-alpha"]}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

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
      const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement;
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
      const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement | null;
      expect(input).not.toBeNull();
      input?.focus();
      expect(document.activeElement).toBe(input);
    });

    const input = container.querySelector('input[aria-label="Search issues"]') as HTMLInputElement;
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

  it("uses workspace summaries instead of the full workspace list on the issues page", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue()]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1");
      expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    });

    act(() => {
      root.unmount();
    });
  });
});
