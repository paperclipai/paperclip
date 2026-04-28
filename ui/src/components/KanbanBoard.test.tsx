// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    className,
    onClick,
  }: {
    children: ReactNode;
    to: string;
    className?: string;
    onClick?: (event: { preventDefault: () => void }) => void;
  }) => <a href={to} className={className} onClick={() => onClick?.({ preventDefault: vi.fn() })}>{children}</a>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    className?: string;
  }) => <button type="button" className={className} onClick={onClick}>{children}</button>,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PointerSensor: vi.fn(),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useSensor: vi.fn(),
  useSensors: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "task-1",
    identifier: "RT2-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "고객 제안서 작성",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: "jarvis-1",
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
    createdAt: new Date("2026-04-25T00:00:00.000Z"),
    updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    goal: {
      id: "goal-1",
      companyId: "company-1",
      parentId: null,
      ownerAgentId: null,
      title: "매출 목표",
      description: null,
      level: "company",
      status: "active",
      createdAt: new Date("2026-04-25T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    },
    workProducts: [{
      id: "wp-1",
      companyId: "company-1",
      projectId: "project-1",
      issueId: "task-1",
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: "document",
      provider: "custom",
      externalId: null,
      title: "제안서 초안",
      url: null,
      status: "draft",
      reviewState: "none",
      isPrimary: true,
      healthStatus: "unknown",
      summary: null,
      metadata: { basePrice: 180000 },
      createdByRunId: null,
      createdAt: new Date("2026-04-25T00:00:00.000Z"),
      updatedAt: new Date("2026-04-25T00:00:00.000Z"),
    }],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  it("renders a RealTycoon2 Trello-style work board with badges and quick edits", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onUpdateIssue = vi.fn();
    const onCreateTask = vi.fn();

    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue(),
            createIssue({
              id: "todo-1",
              identifier: "RT2-2",
              title: "견적 검토",
              parentId: "task-1",
              status: "in_progress",
              workProducts: [],
            }),
          ]}
          agents={[{ id: "jarvis-1", name: "제안 Jarvis" }]}
          onUpdateIssue={onUpdateIssue}
          onCreateTask={onCreateTask}
        />,
      );
    });

    expect(container.textContent).toContain("RealTycoon2 업무 보드");
    expect(container.textContent).toContain("고객 제안서 작성");
    expect(container.textContent).toContain("Task");
    expect(container.textContent).toContain("To-Do 1");
    expect(container.textContent).toContain("산출물 1");
    expect(container.textContent).toContain("180,000원");
    expect(container.textContent).toContain("매출 목표");
    expect(container.textContent).toContain("제안서 초안");

    const statusSelect = container.querySelector('select[aria-label="task-1-status"]') as HTMLSelectElement | null;
    const prioritySelect = container.querySelector('select[aria-label="task-1-priority"]') as HTMLSelectElement | null;
    expect(statusSelect).not.toBeNull();
    expect(prioritySelect).not.toBeNull();

    act(() => {
      statusSelect!.value = "done";
      statusSelect!.dispatchEvent(new Event("change", { bubbles: true }));
      prioritySelect!.value = "high";
      prioritySelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(onUpdateIssue).toHaveBeenCalledWith("task-1", { status: "done" });
    expect(onUpdateIssue).toHaveBeenCalledWith("task-1", { priority: "high" });

    const addTaskButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("새 작업"));
    expect(addTaskButton).toBeDefined();

    act(() => {
      addTaskButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreateTask).toHaveBeenCalledWith("todo");

    act(() => root.unmount());
    container.remove();
  });
});
