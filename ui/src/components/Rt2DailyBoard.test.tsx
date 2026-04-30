// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

import { Rt2DailyBoard } from "./Rt2DailyBoard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Rt2DailyBoard", () => {
  function buildDragEvent(type: string, dataTransfer: { getData: (type: string) => string; setData: (type: string, value: string) => void; effectAllowed?: string }) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    return event;
  }

  it("renders the approved three-lane board and saves card lane changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSaveCard = vi.fn();

    act(() => {
      root.render(
        <Rt2DailyBoard
          board={{
            companyId: "company-1",
            projectId: "project-1",
            userId: "user-1",
            reportDate: "2026-04-17",
            cards: [
              {
                taskIssueId: "task-1",
                todoIssueId: "todo-1",
                taskTitle: "주간 보고",
                todoTitle: "주간 보고서 작성",
                assigneeUserId: "user-1",
                reportDate: "2026-04-17",
                lane: "todo",
                bucketLabel: "",
                progressPercent: 30,
                note: "오전 착수",
                status: "in_progress",
                updatedAt: new Date("2026-04-17T09:00:00Z"),
                deliverableCount: 1,
                submittedDeliverableCount: 0,
                taskDeliverableCount: 0,
                basePriceTotal: 1000,
                qualityStatus: "pending_review",
                okrContextStatus: "connected",
                gapFlags: [],
              },
            ],
            cockpit: {
              summary: {
                tasksWorked: 1,
                todosCompleted: 0,
                deliverablesDefined: 1,
                deliverablesSubmitted: 0,
                effortNoteCount: 1,
                goldImpact: 10,
                xpImpact: 5,
                qualityStatus: "pending_review",
              },
              traceRows: [
                {
                  taskIssueId: "task-1",
                  todoIssueId: "todo-1",
                  taskTitle: "주간 보고",
                  todoTitle: "주간 보고서 작성",
                  projectId: "project-1",
                  projectTitle: "운영 자동화",
                  projectStatus: "in_progress",
                  goalPath: [
                    {
                      id: "goal-1",
                      title: "운영 리듬 개선",
                      level: "objective",
                      status: "active",
                      parentId: null,
                    },
                  ],
                  gapFlags: [],
                },
              ],
              gapFlags: [],
              aiSummary: ["1개 task가 오늘 보고에 연결되었습니다."],
            },
          }}
          pendingTodoIssueId={null}
          onSaveCard={onSaveCard}
        />,
      );
    });

    expect(container.textContent).toContain("할 일");
    expect(container.textContent).toContain("진행 중");
    expect(container.textContent).toContain("완료");
    expect(container.textContent).toContain("주간 보고서 작성");
    expect(container.textContent).toContain("담당 user-1");
    expect(container.textContent).toContain("1 산출물");
    expect(container.textContent).toContain("1,000 Gold");
    expect(container.textContent).toContain("검토 대기");

    const laneSelect = container.querySelector('select[aria-label="todo-1-lane"]');
    const saveButton = container.querySelector('button[aria-label="todo-1-save"]');

    expect(laneSelect).toBeDefined();
    expect(saveButton).toBeDefined();

    act(() => {
      if (laneSelect instanceof HTMLSelectElement) {
        laneSelect.value = "doing";
        laneSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onSaveCard).toHaveBeenCalledWith(
      "todo-1",
      expect.objectContaining({
        projectId: "project-1",
        reportDate: "2026-04-17",
        lane: "doing",
      }),
    );

    const dragStore = new Map<string, string>();
    const dataTransfer = {
      getData: (type: string) => dragStore.get(type) ?? "",
      setData: (type: string, value: string) => {
        dragStore.set(type, value);
      },
      effectAllowed: "move",
    };
    const card = container.querySelector('article[draggable="true"]');
    const supportLane = container.querySelector('section[aria-label="완료 lane"]');

    expect(card).toBeDefined();
    expect(supportLane).toBeDefined();

    act(() => {
      card?.dispatchEvent(buildDragEvent("dragstart", dataTransfer));
      supportLane?.dispatchEvent(buildDragEvent("dragover", dataTransfer));
      supportLane?.dispatchEvent(buildDragEvent("drop", dataTransfer));
    });

    expect(onSaveCard).toHaveBeenCalledWith(
      "todo-1",
      expect.objectContaining({
        projectId: "project-1",
        reportDate: "2026-04-17",
        lane: "done",
      }),
    );

    act(() => root.unmount());
  });
});
