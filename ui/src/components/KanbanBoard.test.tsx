// @vitest-environment jsdom

import { act, type AnchorHTMLAttributes } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { KanbanBoard, resolveKanbanReorderTarget } from "./KanbanBoard";
import { readIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state,
    disableIssueQuicklook: _disableIssueQuicklook,
    onClick,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string | { pathname?: string };
    state?: unknown;
    disableIssueQuicklook?: boolean;
  }) => {
    const href = typeof to === "string" ? to : to.pathname ?? "";
    return (
      <a
        href={href}
        data-to={href}
        data-state={state ? JSON.stringify(state) : undefined}
        data-disable-issue-quicklook={_disableIssueQuicklook ? "true" : undefined}
        onClick={(event) => {
          event.preventDefault();
          onClick?.(event);
        }}
        {...props}
      >
        {children}
      </a>
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
    title: "Board issue",
    description: null,
    dueDate: null,
    status: "todo",
    boardPosition: 0,
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 3, 12, 0, 0));
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it("renders status labels for empty columns", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[]}
          agents={[]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
          onAddIssue={() => undefined}
        />,
      );
    });

    for (const label of ["Backlog", "Todo", "In Progress", "In Review", "Blocked", "Done", "Cancelled"]) {
      expect(container.textContent).toContain(label);
    }
  });

  it("calls onAddIssue with the clicked column status", () => {
    const onAddIssue = vi.fn();

    act(() => {
      root.render(
        <KanbanBoard
          issues={[]}
          agents={[]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
          onAddIssue={onAddIssue}
        />,
      );
    });

    const addTodoButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.title === "Add task to Todo",
    );
    expect(addTodoButton).not.toBeUndefined();
    expect(addTodoButton?.getAttribute("aria-label")).toBe("Add task to Todo");

    act(() => {
      addTodoButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddIssue).toHaveBeenCalledTimes(1);
    expect(onAddIssue).toHaveBeenCalledWith("todo");
  });

  it("preserves project breadcrumb state when opening a board card", () => {
    const issueLinkState = {
      issueDetailBreadcrumb: { label: "Paperclip App", href: "/projects/paperclip-app/issues" },
      issueDetailSource: "issues",
    } as const;

    act(() => {
      root.render(
        <KanbanBoard
          issues={[createIssue()]}
          agents={[]}
          liveIssueIds={new Set()}
          issueLinkState={issueLinkState}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const link = container.querySelector('a[data-to="/issues/PAP-1"]') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-state")).toContain("/projects/paperclip-app/issues");

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(readIssueDetailLocationState("PAP-1", null)).toEqual(expect.objectContaining({
      issueDetailBreadcrumb: { label: "Paperclip App", href: "/projects/paperclip-app/issues" },
      issueDetailSource: "issues",
    }));
  });

  it("sets a card due today without opening the task", () => {
    const onUpdateIssue = vi.fn();

    act(() => {
      root.render(
        <KanbanBoard
          issues={[createIssue({ id: "issue-due", identifier: "PAP-2", dueDate: null })]}
          agents={[]}
          liveIssueIds={new Set()}
          onUpdateIssue={onUpdateIssue}
        />,
      );
    });

    const dueTodayButton = container.querySelector(
      'button[aria-label="Set due date to today"]',
    ) as HTMLButtonElement | null;
    expect(dueTodayButton).not.toBeNull();
    expect(dueTodayButton?.title).toBe("Set due date to today");

    act(() => {
      dueTodayButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onUpdateIssue).toHaveBeenCalledTimes(1);
    expect(onUpdateIssue).toHaveBeenCalledWith("issue-due", { dueDate: "2026-05-03" });
  });

  it("hides the due today action for cards already due today or terminal", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-today", identifier: "PAP-3", dueDate: "2026-05-03" }),
            createIssue({ id: "issue-done", identifier: "PAP-4", status: "done", dueDate: null }),
            createIssue({ id: "issue-cancelled", identifier: "PAP-5", status: "cancelled", dueDate: "2026-05-05" }),
          ]}
          agents={[]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Set due date to today"]')).toBeNull();
  });

  it("renders compact project indicators for board cards with known projects", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-code-project", identifier: "PAP-10", title: "Coded project", projectId: "project-papa" }),
            createIssue({ id: "issue-name-project", identifier: "PAP-11", title: "Named project", projectId: "project-ops" }),
          ]}
          agents={[]}
          projects={[
            { id: "project-papa", name: "PC - Trello board", code: "PAPA", color: "#0ea5e9" },
            { id: "project-ops", name: "Operations", color: null },
          ]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const indicators = Array.from(container.querySelectorAll('[data-testid="kanban-project-indicator"]'));
    expect(indicators).toHaveLength(2);
    expect(indicators[0]?.textContent).toBe("PAPA");
    expect(indicators[0]?.getAttribute("title")).toBe("Project: PC - Trello board (PAPA)");
    expect(indicators[1]?.textContent).toBe("Operations");
  });

  it("omits the project indicator for board cards without a project", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[createIssue({ id: "issue-no-project", identifier: "PAP-12", title: "No project", projectId: null })]}
          agents={[]}
          projects={[{ id: "project-papa", name: "PC - Trello board", code: "PAPA", color: "#0ea5e9" }]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(container.querySelector('[data-testid="kanban-project-indicator"]')).toBeNull();
  });

  it("renders compact issue labels with overflow on board cards", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[createIssue({
            labels: [
              {
                id: "label-bug",
                companyId: "company-1",
                name: "Bug",
                color: "#ef4444",
                createdAt: new Date("2026-04-07T00:00:00.000Z"),
                updatedAt: new Date("2026-04-07T00:00:00.000Z"),
              },
              {
                id: "label-growth",
                companyId: "company-1",
                name: "Growth",
                color: "#22c55e",
                createdAt: new Date("2026-04-07T00:00:00.000Z"),
                updatedAt: new Date("2026-04-07T00:00:00.000Z"),
              },
              {
                id: "label-copy",
                companyId: "company-1",
                name: "Copy",
                color: "#3b82f6",
                createdAt: new Date("2026-04-07T00:00:00.000Z"),
                updatedAt: new Date("2026-04-07T00:00:00.000Z"),
              },
            ],
            labelIds: ["label-bug", "label-growth", "label-copy"],
          })]}
          agents={[]}
          liveIssueIds={new Set()}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("Bug");
    expect(container.textContent).toContain("Growth");
    expect(container.textContent).toContain("+1");
    expect(container.textContent).not.toContain("Copy");
  });

  it("highlights board cards assigned to the current user", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-mine", identifier: "PAP-6", title: "Mine", assigneeUserId: "board-user" }),
            createIssue({ id: "issue-other", identifier: "PAP-7", title: "Other", assigneeUserId: "other-user" }),
          ]}
          agents={[]}
          liveIssueIds={new Set()}
          currentUserId="board-user"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const highlightedCards = Array.from(container.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedCards).toHaveLength(1);
    expect(highlightedCards[0]?.textContent).toContain("Mine");
    expect(highlightedCards[0]?.className).toContain("border-l-4");
    expect(highlightedCards[0]?.className).toContain("bg-cyan-500");
    expect(container.querySelector('[aria-label="Assigned to You"]')).not.toBeNull();
  });

  it("highlights board cards assigned to visible company agents", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-agent", identifier: "PAP-8", title: "Agent work", assigneeAgentId: "agent-steward" }),
            createIssue({ id: "issue-other", identifier: "PAP-9", title: "Other work", assigneeAgentId: "agent-other" }),
          ]}
          agents={[{ id: "agent-steward", name: "Paperclip Steward" }]}
          liveIssueIds={new Set()}
          currentUserId="board-user"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const highlightedCards = Array.from(container.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedCards).toHaveLength(1);
    expect(highlightedCards[0]?.textContent).toContain("Agent work");
    expect(highlightedCards[0]?.className).toContain("border-l-4");
    expect(container.querySelector('[aria-label="Assigned to Paperclip Steward"]')).not.toBeNull();
  });

  it("resolves same-column reorder targets from sortable card positions", () => {
    const issues = [
      createIssue({ id: "issue-a", title: "A", boardPosition: 0 }),
      createIssue({ id: "issue-b", title: "B", boardPosition: 1 }),
      createIssue({ id: "issue-c", title: "C", boardPosition: 2 }),
    ];

    expect(resolveKanbanReorderTarget(issues, "issue-c", "issue-b")).toEqual({
      status: "todo",
      beforeIssueId: "issue-b",
    });
    expect(resolveKanbanReorderTarget(issues, "issue-a", "issue-c")).toEqual({
      status: "todo",
      beforeIssueId: null,
    });
  });

  it("resolves cross-column reorder targets", () => {
    const issues = [
      createIssue({ id: "issue-a", title: "A", status: "todo", boardPosition: 0 }),
      createIssue({ id: "issue-b", title: "B", status: "blocked", boardPosition: 0 }),
    ];

    expect(resolveKanbanReorderTarget(issues, "issue-a", "issue-b")).toEqual({
      status: "blocked",
      beforeIssueId: "issue-b",
    });
    expect(resolveKanbanReorderTarget(issues, "issue-a", "in_progress")).toEqual({
      status: "in_progress",
      beforeIssueId: null,
    });
  });
});
