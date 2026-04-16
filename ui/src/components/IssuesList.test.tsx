// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { epicTone } from "../lib/roadmapEpicStyles";
import { IssuesList } from "./IssuesList";

const DEFAULT_ACTIVE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

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

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockRoadmapApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockCompaniesApi = vi.hoisted(() => ({
  listRoadmapEpics: vi.fn(),
  pauseRoadmapEpic: vi.fn(),
  resumeRoadmapEpic: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const kanbanPropsState = vi.hoisted(() => ({
  latest: null as { issues: Issue[] } | null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/roadmap", () => ({
  roadmapApi: mockRoadmapApi,
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("./IssueRow", () => ({
  IssueRow: ({
    issue,
    desktopTrailing,
    mobileMeta,
    trailingMeta,
    className,
  }: {
    issue: Issue;
    desktopTrailing?: ReactNode;
    mobileMeta?: ReactNode;
    trailingMeta?: ReactNode;
    className?: string;
  }) => (
    <div data-testid="issue-row" data-class-name={className}>
      <span>{issue.title}</span>
      <span data-testid={`issue-row-mobile-meta-${issue.id}`}>{mobileMeta}</span>
      <span data-testid={`issue-row-trailing-${issue.id}`}>{desktopTrailing}</span>
      <span data-testid={`issue-row-trailing-meta-${issue.id}`}>{trailingMeta}</span>
    </div>
  ),
}));

vi.mock("./KanbanBoard", () => ({
  KanbanBoard: (props: { issues: Issue[] }) => {
    kanbanPropsState.latest = props;
    return <div>Kanban board</div>;
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

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {node}
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
    window.localStorage.clear();
    dialogState.openNewIssue.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listLabels.mockReset();
    mockAuthApi.getSession.mockReset();
    mockRoadmapApi.get.mockReset();
    mockCompaniesApi.listRoadmapEpics.mockReset();
    mockCompaniesApi.pauseRoadmapEpic.mockReset();
    mockCompaniesApi.resumeRoadmapEpic.mockReset();
    toastState.pushToast.mockReset();
    kanbanPropsState.latest = null;
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: null, session: null });
    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [],
      },
    });
    mockCompaniesApi.listRoadmapEpics.mockResolvedValue({ pausedEpicIds: [] });
    mockCompaniesApi.pauseRoadmapEpic.mockResolvedValue({ roadmapId: "RM-2026-Q2-01", paused: true });
    mockCompaniesApi.resumeRoadmapEpic.mockResolvedValue({ roadmapId: "RM-2026-Q2-01", paused: false });
  });

  afterEach(() => {
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
      expect(mockIssuesApi.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          q: "server",
          projectId: undefined,
        }),
      );
      expect(container.textContent).toContain("Server result");
      expect(container.textContent).not.toContain("Local issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("does not force open status filtering during search", async () => {
    const issue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });
    mockIssuesApi.list.mockResolvedValue([issue]);

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
      const searchCall = mockIssuesApi.list.mock.calls.find((call) => call[1]?.q === "server");
      expect(searchCall).toBeDefined();
      expect(searchCall?.[1]).not.toHaveProperty("status");
    });

    act(() => {
      root.unmount();
    });
  });

  it("does not exclude recovery source issues during search by default", async () => {
    const issue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });
    mockIssuesApi.list.mockResolvedValue([issue]);

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
      const searchCall = mockIssuesApi.list.mock.calls.find((call) => call[1]?.q === "server");
      expect(searchCall).toBeDefined();
      expect(searchCall?.[1]).not.toHaveProperty("excludeRecoverySourcesWithOpenSuccessors");
    });

    act(() => {
      root.unmount();
    });
  });

  it("propagates explicit recovery source exclusion during search", async () => {
    const issue = createIssue({ id: "issue-server", identifier: "PAP-2", title: "Server result" });
    mockIssuesApi.list.mockResolvedValue([issue]);

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        initialSearch="server"
        excludeRecoverySourcesWithOpenSuccessors
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          q: "server",
          excludeRecoverySourcesWithOpenSuccessors: true,
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("does not render a show closed toggle", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[createIssue({ id: "issue-visible", identifier: "PAP-4", title: "Visible issue" })]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Visible issue");
    });

    expect(container.textContent).not.toContain("Show Closed");
    expect(container.textContent).not.toContain("Hide Closed");

    act(() => {
      root.unmount();
    });
  });

  it("can hide done and cancelled issues by default when configured with active statuses", async () => {
    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-visible", identifier: "PAP-4", title: "Visible issue", status: "todo" }),
          createIssue({ id: "issue-done", identifier: "PAP-5", title: "Done issue", status: "done" }),
          createIssue({ id: "issue-cancelled", identifier: "PAP-6", title: "Cancelled issue", status: "cancelled" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultStatuses={DEFAULT_ACTIVE_STATUSES}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Visible issue");
      expect(container.textContent).not.toContain("Done issue");
      expect(container.textContent).not.toContain("Cancelled issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("migrates legacy saved empty status filters to the configured default statuses", async () => {
    window.localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({
        schemaVersion: 3,
        statuses: [],
      }),
    );

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-visible", identifier: "PAP-7", title: "Open issue", status: "todo" }),
          createIssue({ id: "issue-done", identifier: "PAP-8", title: "Closed issue", status: "done" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultStatuses={DEFAULT_ACTIVE_STATUSES}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Open issue");
      expect(container.textContent).not.toContain("Closed issue");
    });

    const savedState = JSON.parse(window.localStorage.getItem("paperclip:test-issues:company-1") ?? "{}");
    expect(savedState.schemaVersion).toBe(4);
    expect(savedState.statuses).toEqual(DEFAULT_ACTIVE_STATUSES);

    act(() => {
      root.unmount();
    });
  });

  it("preserves an explicit show-all choice once the new schema is saved", async () => {
    window.localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({
        schemaVersion: 4,
        statuses: [],
      }),
    );

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[
          createIssue({ id: "issue-visible", identifier: "PAP-9", title: "Open issue", status: "todo" }),
          createIssue({ id: "issue-done", identifier: "PAP-10", title: "Closed issue", status: "done" }),
        ]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        defaultStatuses={DEFAULT_ACTIVE_STATUSES}
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Open issue");
      expect(container.textContent).toContain("Closed issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("sorts active issues by most recent activity by default", async () => {
    const recentActivityIssue = createIssue({
      id: "issue-recent-activity",
      identifier: "PAP-40",
      title: "Recent activity issue",
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const olderActivityIssue = createIssue({
      id: "issue-older-activity",
      identifier: "PAP-41",
      title: "Older activity issue",
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[olderActivityIssue, recentActivityIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const titles = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.firstElementChild?.textContent);
      expect(titles).toEqual(["Recent activity issue", "Older activity issue"]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("sorts terminal issues by completion recency by default", async () => {
    const recentlyCompletedIssue = createIssue({
      id: "issue-recently-completed",
      identifier: "PAP-50",
      title: "Recently completed issue",
      status: "done",
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
      completedAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const olderCompletedIssue = createIssue({
      id: "issue-older-completed",
      identifier: "PAP-51",
      title: "Older completed issue",
      status: "done",
      updatedAt: new Date("2026-04-10T00:00:00.000Z"),
      completedAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[olderCompletedIssue, recentlyCompletedIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const titles = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.firstElementChild?.textContent);
      expect(titles).toEqual(["Recently completed issue", "Older completed issue"]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("migrates legacy saved updated-ascending state to most-recent descending", async () => {
    window.localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({
        sortField: "updated",
        sortDir: "asc",
      }),
    );

    const recentActivityIssue = createIssue({
      id: "issue-migrated-recent",
      identifier: "PAP-52",
      title: "Migrated recent issue",
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const olderActivityIssue = createIssue({
      id: "issue-migrated-older",
      identifier: "PAP-53",
      title: "Migrated older issue",
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[olderActivityIssue, recentActivityIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const titles = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.firstElementChild?.textContent);
      expect(titles).toEqual(["Migrated recent issue", "Migrated older issue"]);
    });

    const savedState = JSON.parse(window.localStorage.getItem("paperclip:test-issues:company-1") ?? "{}");
    expect(savedState.schemaVersion).toBe(4);
    expect(savedState.sortField).toBe("recent");
    expect(savedState.sortDir).toBe("desc");

    act(() => {
      root.unmount();
    });
  });

  it("migrates schema-versioned updated sorting to the new recent sort key", async () => {
    window.localStorage.setItem(
      "paperclip:test-issues:company-1",
      JSON.stringify({
        schemaVersion: 2,
        sortField: "updated",
        sortDir: "asc",
      }),
    );

    const recentActivityIssue = createIssue({
      id: "issue-schema-migrated-recent",
      identifier: "PAP-54",
      title: "Schema migrated recent issue",
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const olderActivityIssue = createIssue({
      id: "issue-schema-migrated-older",
      identifier: "PAP-55",
      title: "Schema migrated older issue",
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[olderActivityIssue, recentActivityIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const titles = Array.from(container.querySelectorAll('[data-testid="issue-row"]'))
        .map((row) => row.firstElementChild?.textContent);
      expect(titles).toEqual(["Schema migrated recent issue", "Schema migrated older issue"]);
    });

    const savedState = JSON.parse(window.localStorage.getItem("paperclip:test-issues:company-1") ?? "{}");
    expect(savedState.schemaVersion).toBe(4);
    expect(savedState.sortField).toBe("recent");
    expect(savedState.sortDir).toBe("desc");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the sort control in board view and passes most-recent ordering to the board", async () => {
    const recentActivityIssue = createIssue({
      id: "issue-board-recent",
      identifier: "PAP-60",
      title: "Board recent issue",
      status: "todo",
      updatedAt: new Date("2026-04-07T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-09T00:00:00.000Z"),
    });
    const olderActivityIssue = createIssue({
      id: "issue-board-older",
      identifier: "PAP-61",
      title: "Board older issue",
      status: "todo",
      updatedAt: new Date("2026-04-08T00:00:00.000Z"),
      lastActivityAt: new Date("2026-04-08T00:00:00.000Z"),
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[olderActivityIssue, recentActivityIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Sort");
    });

    const boardViewButton = container.querySelector<HTMLButtonElement>('button[title="Board view"]');
    expect(boardViewButton).not.toBeNull();

    act(() => {
      boardViewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Kanban board");
      expect(container.textContent).toContain("Sort");
      expect(kanbanPropsState.latest?.issues.map((issue) => issue.title)).toEqual([
        "Board recent issue",
        "Board older issue",
      ]);
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders a what's blocked on me section for blocked issues waiting on my work", async () => {
    mockAuthApi.getSession.mockResolvedValue({
      user: { id: "user-me" },
      session: { userId: "user-me" },
    });

    const blockedIssue = createIssue({
      id: "issue-blocked",
      identifier: "PAP-22",
      title: "Finish release notes",
      status: "blocked",
      blockedBy: [
        {
          id: "issue-blocker",
          identifier: "PAP-21",
          title: "Approve copy",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: "user-me",
        },
      ],
    });
    const unrelatedBlockedIssue = createIssue({
      id: "issue-other",
      identifier: "PAP-30",
      title: "Wait on vendor reply",
      status: "blocked",
      blockedBy: [
        {
          id: "issue-external",
          identifier: "PAP-29",
          title: "Vendor follow-up",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: "user-someone-else",
        },
      ],
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[blockedIssue, unrelatedBlockedIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const section = container.querySelector('[data-testid="blocked-on-me-section"]');
      expect(section?.textContent).toContain("What's blocked on me");
      expect(section?.textContent).toContain("Finish release notes");
      expect(section?.textContent).toContain("PAP-21");
      expect(section?.textContent).not.toContain("Wait on vendor reply");
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders board-state summary copy from the server instead of client blocker guesswork", async () => {
    const blockedIssue = createIssue({
      id: "issue-blocked",
      identifier: "COMA-1118",
      title: "Leaf issue",
      status: "blocked",
      boardState: {
        kind: "blocked",
        headline: "Blocked by COMA-1098",
        reasonCode: null,
        actorType: "issue",
        actorId: "blocker-1",
        primaryAction: null,
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[blockedIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Blocked by COMA-1098");
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides redirected recovery ancestors when explicit recovery-source exclusion is enabled", async () => {
    const redirectedIssue = createIssue({
      id: "issue-redirected",
      identifier: "COMA-1056",
      title: "Superseded work item",
      status: "blocked",
      recoverySuccessor: {
        id: "issue-successor",
        identifier: "COMA-1122",
        title: "Latest active work item",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      boardState: {
        kind: "redirected",
        headline: "Superseded by COMA-1122",
        reasonCode: "recovery",
        actorType: "issue",
        actorId: "issue-successor",
        primaryAction: null,
      },
    });
    const activeIssue = createIssue({
      id: "issue-active",
      identifier: "COMA-1122",
      title: "Latest active work item",
      status: "in_progress",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[redirectedIssue, activeIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        excludeRecoverySourcesWithOpenSuccessors
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Latest active work item");
      expect(container.textContent).not.toContain("Superseded work item");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps redirected closed recovery history visible when the successor is no longer open", async () => {
    const redirectedClosedIssue = createIssue({
      id: "issue-redirected-closed",
      identifier: "COMA-1056",
      title: "Superseded closed work item",
      status: "cancelled",
      recoverySuccessor: {
        id: "issue-successor",
        identifier: "COMA-1122",
        title: "Completed continuation",
        status: "done",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      boardState: {
        kind: "redirected",
        headline: "Superseded by COMA-1122",
        reasonCode: "recovery",
        actorType: "issue",
        actorId: "issue-successor",
        primaryAction: null,
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[redirectedClosedIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        excludeRecoverySourcesWithOpenSuccessors
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Superseded closed work item");
    });

    act(() => {
      root.unmount();
    });
  });

  it("applies single-select epic pill filtering and toggles off on second click", async () => {
    const epicOneIssue = createIssue({
      id: "issue-epic-1",
      identifier: "PAP-11",
      title: "First epic issue",
      description: "Tracked under RM-2026-Q2-01",
    });
    const epicTwoIssue = createIssue({
      id: "issue-epic-2",
      identifier: "PAP-12",
      title: "Second epic issue",
      description: "Tracked under RM-2026-Q2-02",
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicOneIssue, epicTwoIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First epic issue");
      expect(container.textContent).toContain("Second epic issue");
    });

    const epicPill = container.querySelector<HTMLButtonElement>('button[data-epic-filter-pill="RM-2026-Q2-01"]');
    expect(epicPill).not.toBeNull();

    act(() => {
      epicPill!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First epic issue");
      expect(container.textContent).not.toContain("Second epic issue");
    });

    act(() => {
      epicPill!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First epic issue");
      expect(container.textContent).toContain("Second epic issue");
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders epic pills with roadmap titles instead of raw epic ids", async () => {
    const epicIssue = createIssue({
      id: "issue-epic-1",
      identifier: "PAP-11",
      title: "First epic issue",
      description: "Tracked under RM-2026-Q2-01",
    });

    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [
          {
            title: "Q2",
            items: [
              {
                id: "RM-2026-Q2-01",
                title: "Ship OAuth flow",
                fields: [],
              },
            ],
          },
        ],
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockRoadmapApi.get).toHaveBeenCalledWith("company-1");
      const epicPill = container.querySelector<HTMLButtonElement>('button[data-epic-filter-pill="RM-2026-Q2-01"]');
      expect(epicPill).not.toBeNull();
      expect(epicPill!.textContent).toContain("Ship OAuth flow");
      expect(epicPill!.textContent).not.toContain("RM-2026-Q2-01");
      const rowTrailing = container.querySelector('[data-testid="issue-row-trailing-issue-epic-1"]');
      expect(rowTrailing?.textContent).toContain("Ship OAuth flow");
      expect(rowTrailing?.textContent).not.toContain("RM-2026-Q2-01");
    });

    act(() => {
      root.unmount();
    });
  });

  it("applies the epic tone to list rows", async () => {
    const epicIssue = createIssue({
      id: "issue-epic-1",
      identifier: "PAP-11",
      title: "First epic issue",
      description: "Tracked under RM-2026-Q2-01",
    });

    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [
          {
            title: "Q2",
            items: [
              {
                id: "RM-2026-Q2-01",
                title: "Ship OAuth flow",
                fields: [],
              },
            ],
          },
        ],
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    await waitForAssertion(() => {
      const row = container.querySelector('[data-testid="issue-row"]');
      const tone = epicTone("RM-2026-Q2-01");
      expect(row?.getAttribute("data-class-name")).toContain(tone.row);
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows the selected epic as a scoped header and pauses it from the details panel", async () => {
    const epicIssue = createIssue({
      id: "issue-epic-1",
      identifier: "PAP-11",
      title: "First epic issue",
      description: "Tracked under RM-2026-Q2-01",
    });

    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [
          {
            title: "Q2",
            items: [
              {
                id: "RM-2026-Q2-01",
                title: "Ship OAuth flow",
                fields: [
                  {
                    key: "Purpose",
                    value: "Let users sign in with providers instead of passwords.",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const epicPill = await waitForEpicPill(container, "RM-2026-Q2-01");

    act(() => {
      epicPill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Epic Focus");
      expect(container.textContent).toContain("1 issue in scope");
      expect(container.textContent).toContain("Let users sign in with providers instead of passwords.");
      expect(container.textContent).toContain("Pause Epic");
    });

    const pauseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Pause Epic"));
    expect(pauseButton).toBeDefined();

    await act(async () => {
      pauseButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    await waitForAssertion(() => {
      expect(mockCompaniesApi.pauseRoadmapEpic).toHaveBeenCalledWith("company-1", "RM-2026-Q2-01");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows epic complete state and hides pause controls when all epic issues are done", async () => {
    const epicIssue = createIssue({
      id: "issue-epic-complete-1",
      identifier: "PAP-21",
      title: "Completed epic issue",
      description: "Tracked under RM-2026-Q2-01",
      status: "done",
    });

    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [
          {
            title: "Q2",
            items: [
              {
                id: "RM-2026-Q2-01",
                title: "Ship OAuth flow",
                fields: [],
              },
            ],
          },
        ],
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const epicPill = await waitForEpicPill(container, "RM-2026-Q2-01");

    act(() => {
      epicPill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Epic complete");
      const pauseButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Pause Epic"));
      expect(pauseButton).toBeUndefined();
      expect(mockCompaniesApi.pauseRoadmapEpic).not.toHaveBeenCalled();
      expect(mockCompaniesApi.resumeRoadmapEpic).not.toHaveBeenCalled();
    });

    act(() => {
      root.unmount();
    });
  });

  it("hides visible epic chips in issue rows once an epic is selected", async () => {
    const epicIssue = createIssue({
      id: "issue-epic-1",
      identifier: "PAP-11",
      title: "First epic issue",
      description: "Tracked under RM-2026-Q2-01",
    });

    mockRoadmapApi.get.mockResolvedValue({
      index: { path: "/doc/ROADMAP.md", markdown: "", links: [] },
      roadmap: {
        label: "Roadmap",
        path: "/doc/ROADMAP.md",
        title: "Roadmap",
        status: null,
        owner: null,
        lastUpdated: null,
        contract: [],
        markdown: "",
        sections: [
          {
            title: "Q2",
            items: [
              {
                id: "RM-2026-Q2-01",
                title: "Ship OAuth flow",
                fields: [],
              },
            ],
          },
        ],
      },
    });

    const { root } = renderWithQueryClient(
      <IssuesList
        issues={[epicIssue]}
        agents={[]}
        projects={[]}
        viewStateKey="paperclip:test-issues"
        onUpdateIssue={() => undefined}
      />,
      container,
    );

    const epicPill = await waitForEpicPill(container, "RM-2026-Q2-01");

    await waitForAssertion(() => {
      const rowTrailing = container.querySelector('[data-testid="issue-row-trailing-issue-epic-1"]');
      expect(rowTrailing?.textContent).toContain("Ship OAuth flow");
    });

    act(() => {
      epicPill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      const rowTrailing = container.querySelector('[data-testid="issue-row-trailing-issue-epic-1"]');
      expect(rowTrailing?.textContent).not.toContain("Ship OAuth flow");
    });

    act(() => {
      root.unmount();
    });
  });
});

async function waitForEpicPill(container: HTMLDivElement, epicId: string): Promise<HTMLButtonElement> {
  let pill: HTMLButtonElement | null = null;
  await waitForAssertion(() => {
    pill = container.querySelector<HTMLButtonElement>(`button[data-epic-filter-pill="${epicId}"]`);
    expect(pill).not.toBeNull();
  });
  return pill!;
}
