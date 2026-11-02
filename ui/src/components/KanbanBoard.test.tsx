// @vitest-environment jsdom

import type { DragStartEvent, DragEndEvent } from "@dnd-kit/core";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { Issue, IssueStatus } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READABLE_TEXT_DARK } from "../lib/color-contrast";
import { getKanbanColumnTone, KanbanBoard, resolveKanbanTargetStatus } from "./KanbanBoard";

const dragCallbacks = vi.hoisted(() => ({
  start: undefined as ((event: DragStartEvent) => void) | undefined,
  end: undefined as ((event: DragEndEvent) => void) | undefined,
}));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
      dragCallbacks.start = props.onDragStart;
      dragCallbacks.end = props.onDragEnd;
      return <actual.DndContext {...props} />;
    },
    DragOverlay: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="drag-overlay">{children}</div>
    ),
  };
});

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    disableIssueQuicklook?: boolean;
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

  it.each([false, true])("renders all colored labels below the title (compact: %s)", (compactCards) => {
    const issue = createIssue(1, "todo");
    issue.labels = ["Ação", "Revisão", "Uma etiqueta muito longa sem perder seu nome completo"].map((name, i) => ({
      id: `label-${i}`, companyId: issue.companyId, name, color: READABLE_TEXT_DARK,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt,
    }));
    const { container } = renderBoard({ issues: [issue], compactCards });
    const group = container.querySelector('[aria-label="Task labels"]')!;
    expect(group).not.toBeNull();
    const link = group.closest("a")!;
    expect(link.getAttribute("href")).toBe("/issues/PAP-1");
    const title = link.querySelector("p")!;
    expect(title.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.classList.contains("flex-wrap")).toBe(true);
    for (const label of issue.labels) {
      const badge = group.querySelector<HTMLElement>(`[title="${label.name}"]`)!;
      expect(badge.textContent).toBe(label.name);
      const expected = document.createElement("span");
      expected.style.borderColor = label.color;
      expected.style.backgroundColor = `${label.color}1f`;
      expect(badge.style.borderColor).toBe(expected.style.borderColor);
      expect(badge.style.backgroundColor).toBe(expected.style.backgroundColor);
      expect(badge.classList.contains("max-w-full")).toBe(true);
    }
  });

  it.each([false, true])("hides labels and refreshes task data (overflow fades: %s)", (showOverflowFades) => {
    const issue = createIssue(1, "todo");
    issue.labels = [{ id: "label-1", companyId: issue.companyId, name: "Original", color: READABLE_TEXT_DARK,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt }];
    const { container, render } = renderBoard({ issues: [issue], showLabels: false, showOverflowFades });
    expect(container.querySelector('[aria-label="Task labels"]')).toBeNull();
    render({ issues: [issue], showLabels: true, showOverflowFades });
    expect(container.textContent).toContain("Original");
    render({ issues: [{ ...issue, labels: [{ ...issue.labels[0], name: "Atualizada" }] }], showOverflowFades });
    expect(container.textContent).toContain("Atualizada");
    expect(container.textContent).not.toContain("Original");
  });

  it("does not reserve label space for tasks without labels", () => {
    const { container, render } = renderBoard({ issues: [createIssue(1, "todo")] });
    expect(container.querySelector('[aria-label="Task labels"]')).toBeNull();
    render({ issues: [{ ...createIssue(1, "todo"), labels: undefined }] });
    expect(container.querySelector('[aria-label="Task labels"]')).toBeNull();
  });

  it.each([false, true])("keeps label visibility in the drag overlay (showLabels: %s)", (showLabels) => {
    const issue = createIssue(1, "todo");
    issue.labels = [{ id: "label-1", companyId: issue.companyId, name: "Revisão", color: READABLE_TEXT_DARK,
      createdAt: issue.createdAt, updatedAt: issue.updatedAt }];
    const onUpdateIssue = vi.fn();
    const { container } = renderBoard({ issues: [issue], showLabels, onUpdateIssue });
    act(() => { dragCallbacks.start?.({ active: { id: issue.id } } as DragStartEvent); });
    const overlay = container.querySelector('[data-testid="drag-overlay"]')!;
    expect(overlay.textContent).toContain(issue.title);
    expect(overlay.querySelector('[aria-label="Task labels"]') !== null).toBe(showLabels);
    act(() => {
      dragCallbacks.end?.({ active: { id: issue.id }, over: { id: "in_progress" } } as DragEndEvent);
    });
    expect(onUpdateIssue).toHaveBeenCalledExactlyOnceWith(issue.id, { status: "in_progress" });
    expect(overlay.textContent).toBe("");
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
    expect(getKanbanColumnTone("blocked").body).toContain("red");
    expect(getKanbanColumnTone("done").body).toContain("green");
    expect(getKanbanColumnTone("cancelled").body).toContain("bg-muted/25");
    expect(getKanbanColumnTone("cancelled").card).toContain("opacity-80");
  });

  it("ghosts cancelled lane cards", () => {
    const { container } = renderBoard({
      issues: createIssues(1, "cancelled"),
    });

    const card = container.querySelector('a[href="/issues/PAP-1"]')?.parentElement;

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

  it("resolves drop targets from status rails and cards", () => {
    const issues = [
      createIssue(1, "todo"),
      createIssue(2, "blocked"),
    ];

    expect(resolveKanbanTargetStatus("done", issues)).toBe("done");
    expect(resolveKanbanTargetStatus("issue-blocked-2", issues)).toBe("blocked");
    expect(resolveKanbanTargetStatus("missing", issues)).toBeNull();
  });
});
