// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKanbanColumnTone, KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";
import type { IssueOverviewsResult } from "../hooks/useIssueOverviews";

const overviewState = vi.hoisted<IssueOverviewsResult>(() => ({
  byId: new Map(),
  isPending: false,
  error: null,
  dataUpdatedAt: 0,
  refetch: vi.fn(),
}));

vi.mock("../hooks/useIssueOverviews", () => ({
  useIssueOverviews: () => overviewState,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
    issuePrefetch?: unknown;
  }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

function act(callback: () => void): void {
  flushSync(callback);
}

function createIssue(index: number, status: IssueStatus): Issue {
  return {
    id: `issue-${status}-${index}`,
    identifier: `PAP-${index}`,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: `Issue ${index}`,
    description: null,
    status,
    workMode: "standard",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: index === 1 ? "agent-1" : null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: index,
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
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
  };
}

function createIssues(count: number, status: IssueStatus): Issue[] {
  return Array.from({ length: count }, (_, index) => createIssue(index + 1, status));
}

function createOverview(issueId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issueId,
    phase: "todo",
    phaseSource: "status",
    blocked: false,
    project: null,
    parent: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    blocker: null,
    pullRequests: [],
    delivery: null,
    ...overrides,
  };
}

 function renderBoard(
  props: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  const render = (nextProps: Partial<React.ComponentProps<typeof KanbanBoard>> & { issues: Issue[] }) => {
    act(() => {
      root.render(
        <KanbanBoard
          agents={[{ id: "agent-1", name: "Codex" }]}
          liveIssueIds={new Set(["issue-todo-1"])}
          onUpdateIssue={vi.fn()}
          {...nextProps}
        />,
      );
    });
  };

  render(props);

  return { container, root, render };
}

describe("KanbanBoard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    overviewState.byId = new Map();
    overviewState.isPending = false;
    overviewState.error = null;
    overviewState.refetch.mockReset();
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop();
      if (root) {
        act(() => root.unmount());
      }
    }
    document.body.innerHTML = "";
  });

  it("limits visible cards and reveals more cards per column", () => {
    const { container } = renderBoard({
      issues: createIssues(60, "todo"),
      compactCards: true,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    expect(container.textContent).toContain("Showing 50 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 50");
    expect(container.textContent).not.toContain("Issue 51");

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");
    expect(container.textContent).not.toContain("Show 10 more");
  });

  it("resets visible counts when the column page size changes", () => {
    const issues = createIssues(60, "todo");
    const { container, render } = renderBoard({
      issues,
      initialVisibleCount: 50,
      revealIncrement: 50,
    });

    const showMoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 10 more"),
    );
    expect(showMoreButton).toBeTruthy();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Issue 60");

    render({
      issues,
      initialVisibleCount: 10,
      revealIncrement: 10,
    });

    expect(container.textContent).toContain("Showing 10 of 60");
    expect(container.textContent).toContain("Show 10 more");
    expect(container.textContent).toContain("Issue 10");
    expect(container.textContent).not.toContain("Issue 11");
  });

  it("renders collapsed statuses as rails without cards", () => {
    const { container } = renderBoard({
      issues: createIssues(3, "done"),
      collapsedStatuses: ["done"],
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("3");
    expect(container.textContent).not.toContain("Issue 1");
  });

  it("gives every column a status-hued tone", () => {
    expect(getKanbanColumnTone("backlog").body).toContain("bg-muted/30");
    expect(getKanbanColumnTone("todo").body).toContain("amber");
    expect(getKanbanColumnTone("in_progress").body).toContain("blue");
    expect(getKanbanColumnTone("in_review").body).toContain("violet");
    expect(getKanbanColumnTone("ready_to_merge").body).toContain("teal");
    expect(getKanbanColumnTone("merging").body).toContain("indigo");
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "cancelled"),
    });

    const card = container.querySelector('a[href="/issues/PAP-1"]')?.closest('[data-testid="kanban-card"]');

    expect(card?.className).toContain("bg-muted/35");
    expect(card?.className).toContain("opacity-80");
  });

  it("keeps core issue signals in compact cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "todo"),
      compactCards: true,
    });

    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).toContain("Codex");
    expect(container.textContent).toContain("Live");
  });

  it("never resolves controller-owned lanes as drop targets", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
      createIssue(3, "ready_to_merge"),
    ];

    expect(resolveKanbanTargetStatus("ready_to_merge", issues)).toBeNull();
    expect(resolveKanbanTargetStatus("merging", issues)).toBeNull();
    expect(resolveKanbanTargetStatus("issue-ready_to_merge-3", issues)).toBeNull();
    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-todo-1", issues)).toBe("todo");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });

  it("has no blocked lane: blocked drops resolve to the projected phase", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("blocked", issues)).toBeNull();
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBeNull();

    overviewState.byId = new Map([
      ["issue-blocked-2", createOverview("issue-blocked-2", { phase: "in_review", blocked: true })],
    ]);
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues, overviewState.byId)).toBe("in_review");
    expect(resolveKanbanTargetStatus("project-1:in_review", issues, overviewState.byId)).toBe("in_review");
    expect(resolveKanbanTargetStatus("project-1:blocked", issues, overviewState.byId)).toBeNull();

    overviewState.byId = new Map([
      ["issue-blocked-2", createOverview("issue-blocked-2", { phase: "ready_to_merge", blocked: true })],
    ]);
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues, overviewState.byId)).toBeNull();
  });

  it("marks controller-owned lanes as controller-managed", () => {
    const { container } = renderBoard({
      issues: [createIssue(1, "ready_to_merge"), createIssue(2, "todo")],
    });

    const controllerHeader = container.querySelector('[title*="delivery controller"]');
    expect(controllerHeader?.textContent).toContain("Controller");
    expect(controllerHeader?.textContent).toContain("Ready To Merge");
  });

  it("keeps blocked cards in their projected phase with named blocker context", () => {
    const blockedIssue = { ...createIssue(2, "blocked"), projectId: "project-1" };
    overviewState.byId = new Map([
      ["issue-blocked-2", createOverview("issue-blocked-2", {
        phase: "in_progress",
        phaseSource: "history",
        blocked: true,
        project: { id: "project-1", name: "Platform", color: "#2563eb" },
        parent: { id: "issue-parent", identifier: "PAP-9", title: "Parent thing", status: "todo" },
        blocker: {
          message: "Waiting on the API change",
          ownerLabel: "Ops",
          nextAction: "Approve the migration",
          issues: [
            { id: "blocker-1", identifier: "PAP-7", title: "API change", status: "in_review" },
            { id: "blocker-2", identifier: "PAP-8", title: "Second dep", status: "todo" },
          ],
        },
        children: [
          { id: "child-1", identifier: "PAP-11", title: "First subtask", status: "done" },
          { id: "child-2", identifier: "PAP-12", title: "Second subtask", status: "todo" },
          { id: "child-3", identifier: "PAP-13", title: "Third subtask", status: "todo" },
        ],
        childCount: 3,
        completedChildCount: 1,
        pullRequests: [
          { url: "https://example.test/repo/pull/1", number: 1, repository: "repo", state: "open", updatedAt: null, stale: false },
          { url: "https://example.test/repo/pull/2", number: 2, repository: "repo", state: "merged", updatedAt: null, stale: false },
        ],
      })],
    ]);
    const { container } = renderBoard({
      issues: [blockedIssue, createIssue(1, "in_progress")],
      projects: [{ id: "project-1", name: "Platform", color: "#2563eb" }],
    });

    expect(container.querySelector('[data-kanban-lane="blocked"]')).toBeNull();
    const lane = container.querySelector('[data-kanban-lane="in_progress"]');
    expect(lane?.textContent).toContain("Issue 2");
    expect(lane?.textContent).toContain("Platform");
    expect(lane?.textContent).toContain("PAP-9");
    expect(lane?.textContent).toContain("Blocked by");
    expect(lane?.textContent).toContain("PAP-7");
    expect(lane?.textContent).toContain("+1");
    expect(lane?.textContent).toContain("Waiting on the API change");
    expect(lane?.textContent).toContain("repo#1");
    expect(lane?.textContent).toContain("Open");
    expect(lane?.textContent).toContain("Merged");
    expect(lane?.textContent).toContain("1/3 subtasks");
    expect(container.querySelector('a[href="https://example.test/repo/pull/1"]')).toBeTruthy();
  });

  it("parks phase-unknown cards in an explained attention area, not a default lane", () => {
    const { container } = renderBoard({
      issues: [createIssue(2, "blocked"), createIssue(1, "todo")],
    });

    const unknown = container.querySelector('[data-kanban-unknown="true"]');
    expect(unknown?.textContent).toContain("Stage not recorded");
    expect(unknown?.textContent).toContain("Issue 2");
    expect(container.querySelector('[data-kanban-lane="todo"]')?.textContent).toContain("Issue 1");
    expect(container.querySelector('[data-kanban-lane="todo"]')?.textContent).not.toContain("Issue 2");
  });

  it("expands child tasks inline from the card", () => {
    overviewState.byId = new Map([
      ["issue-todo-1", createOverview("issue-todo-1", {
        phase: "todo",
        children: [
          { id: "child-1", identifier: "PAP-11", title: "First subtask", status: "done" },
        ],
        childCount: 1,
        completedChildCount: 1,
      })],
    ]);
    const { container } = renderBoard({ issues: [createIssue(1, "todo")] });

    const toggle = container.querySelector('[data-testid="kanban-card-children-toggle"]');
    expect(toggle?.textContent).toContain("1/1 subtasks");
    expect(container.textContent).not.toContain("First subtask");

    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("First subtask");
  });

  it("shows overview fetch errors with a retry instead of hiding them", () => {
    overviewState.error = new Error("context exploded");
    const { container } = renderBoard({ issues: [createIssue(1, "todo")] });

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Task context unavailable");
    expect(alert?.textContent).toContain("Issue 1");

    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Retry"),
    );
    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(overviewState.refetch).toHaveBeenCalled();
  });

  it("groups lanes by project swimlanes and filters to outcomes", () => {
    const parent = { ...createIssue(1, "todo"), projectId: "project-1" };
    const child = { ...createIssue(2, "todo"), id: "issue-child", identifier: "PAP-20", parentId: parent.id };
    const { container, render } = renderBoard({
      issues: [parent, child],
      projects: [{ id: "project-1", name: "Platform" }],
      swimlanes: true,
      scope: "all",
    });

    expect(container.querySelector('[aria-label="Platform swimlane"]')).toBeTruthy();
    expect(container.textContent).toContain("PAP-20");

    render({
      issues: [parent, child],
      projects: [{ id: "project-1", name: "Platform" }],
      swimlanes: true,
      scope: "outcomes",
    });
    expect(container.textContent).toContain("Issue 1");
    expect(container.textContent).not.toContain("PAP-20");
  });
});
