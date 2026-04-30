// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Rt2DailyBoard as Rt2DailyBoardData } from "@paperclipai/shared";

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
  function buildBoard(overrides: Partial<Rt2DailyBoardData> = {}): Rt2DailyBoardData {
    const board: Rt2DailyBoardData = {
      companyId: "company-1",
      projectId: "project-1",
      userId: "user-1",
      reportDate: "2026-04-30",
      cards: [
        {
          taskIssueId: "task-1",
          todoIssueId: "todo-1",
          taskTitle: "주간 운영 리포트",
          todoTitle: "고객 리포트 정리",
          assigneeUserId: "user-1",
          reportDate: "2026-04-30",
          lane: "todo",
          bucketLabel: "",
          progressPercent: 20,
          note: "오전 착수",
          status: "in_progress",
          updatedAt: new Date("2026-04-30T09:00:00.000Z"),
          deliverableCount: 0,
          submittedDeliverableCount: 0,
          taskDeliverableCount: 0,
          basePriceTotal: 0,
          qualityStatus: "pending_review",
          okrContextStatus: "connected",
          gapFlags: ["missing_deliverable"],
        },
        {
          taskIssueId: "task-2",
          todoIssueId: "todo-2",
          taskTitle: "매출 분석",
          todoTitle: "Gold 가격표 검수",
          assigneeUserId: "user-2",
          reportDate: "2026-04-29",
          lane: "doing",
          bucketLabel: "",
          progressPercent: 70,
          note: "수정 필요",
          status: "in_review",
          updatedAt: new Date("2026-04-30T10:00:00.000Z"),
          deliverableCount: 1,
          submittedDeliverableCount: 1,
          taskDeliverableCount: 1,
          basePriceTotal: 90000,
          qualityStatus: "pending_review",
          okrContextStatus: "missing_goal",
          gapFlags: [],
        },
      ],
      cockpit: {
        summary: {
          tasksWorked: 2,
          todosCompleted: 0,
          deliverablesDefined: 1,
          deliverablesSubmitted: 1,
          effortNoteCount: 2,
          goldImpact: 900,
          xpImpact: 450,
          qualityStatus: "pending_review",
        },
        traceRows: [
          {
            taskIssueId: "task-1",
            todoIssueId: "todo-1",
            taskTitle: "주간 운영 리포트",
            todoTitle: "고객 리포트 정리",
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
            gapFlags: ["missing_deliverable"],
          },
        ],
        gapFlags: [
          {
            kind: "missing_deliverable",
            taskIssueId: "task-1",
            todoIssueId: "todo-1",
            label: "고객 리포트 정리에 산출물이 없습니다.",
          },
        ],
        aiSummary: ["2개 업무가 오늘 보드에 연결되었습니다."],
      },
    };

    return { ...board, ...overrides };
  }

  function renderBoard(props: Partial<Parameters<typeof Rt2DailyBoard>[0]> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSaveCard = vi.fn();
    const board = props.board ?? buildBoard();

    act(() => {
      root.render(
        <Rt2DailyBoard
          board={board}
          pendingTodoIssueId={props.pendingTodoIssueId ?? null}
          failedTodoIssueId={props.failedTodoIssueId ?? null}
          onSaveCard={props.onSaveCard ?? onSaveCard}
        />,
      );
    });

    return { container, root, onSaveCard, board };
  }

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

  it("keeps cards scan-first and opens quick edit only after card edit intent", () => {
    const { container, root } = renderBoard();

    expect(container.textContent).toContain("고객 리포트 정리");
    expect(container.querySelector('input[aria-label="todo-1-title"]')).toBeNull();
    expect(container.querySelector('select[aria-label="todo-1-quality"]')).toBeNull();

    const editButton = container.querySelector('button[aria-label="todo-1-card-edit"]');
    expect(editButton).not.toBeNull();

    act(() => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("제목");
    expect(container.textContent).toContain("리스트");
    expect(container.textContent).toContain("산출물");
    expect(container.textContent).toContain("기준가");
    expect(container.textContent).toContain("품질");
    expect(container.textContent).toContain("OKR");
    expect(container.querySelector('input[aria-label="todo-1-title"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("shows independent Korean save feedback for each quick-edit field", () => {
    const { container, root } = renderBoard({
      pendingTodoIssueId: "todo-1",
      failedTodoIssueId: "todo-2",
    });

    expect(container.textContent).toContain("제목 저장중");
    expect(container.textContent).toContain("리스트 저장중");
    expect(container.textContent).toContain("산출물 저장중");
    expect(container.textContent).toContain("기준가 저장중");
    expect(container.textContent).toContain("품질 저장중");
    expect(container.textContent).toContain("OKR 저장중");
    expect(container.textContent).toContain("제목 저장 실패");
    expect(container.textContent).toContain("다시 시도");
    expect(container.textContent).toContain("OKR 연결을 저장하지 못했습니다. 다시 시도해 주세요.");

    act(() => root.unmount());
  });

  it("renders five composable Korean board filter chips with pressed state", () => {
    const { container, root } = renderBoard();
    const labels = ["오늘 업무", "내 업무", "산출물 누락", "승인 대기", "품질 이슈"];

    for (const label of labels) {
      const chip = container.querySelector(`button[aria-label="${label}"]`);
      expect(chip).not.toBeNull();
      expect(chip?.getAttribute("aria-pressed")).toBe("false");
    }

    const missingDeliverable = container.querySelector('button[aria-label="산출물 누락"]');
    act(() => {
      missingDeliverable?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(missingDeliverable?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("할 일");
    expect(container.textContent).toContain("진행 중");
    expect(container.textContent).toContain("완료");

    act(() => root.unmount());
  });

  it("searches card title, task title, assignee, deliverable, OKR, and status text without raw HTML rendering", () => {
    const { container, root } = renderBoard({
      board: buildBoard({
        cards: [
          {
            ...buildBoard().cards[0],
            todoTitle: "<img src=x onerror=alert(1)> 고객 리포트 정리",
          },
          buildBoard().cards[1],
        ],
      }),
    });
    const search = container.querySelector('input[aria-label="업무 카드 검색"]');

    expect(search).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)> 고객 리포트 정리");

    for (const term of ["고객 리포트", "주간 운영", "user-1", "운영 리듬", "검토 대기"]) {
      act(() => {
        if (search instanceof HTMLInputElement) {
          search.value = term;
          search.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      expect(container.textContent).toContain("고객 리포트 정리");
    }

    act(() => root.unmount());
  });

  it("sorts within visible lanes only and never calls save for view-order changes", () => {
    const { container, root, onSaveCard } = renderBoard();
    const sort = container.querySelector('select[aria-label="정렬"]');
    const expectedSortOptions = ["기본 순서", "최근 수정순", "마감일순", "보완 필요 먼저", "품질 이슈 먼저", "Gold 높은순"];

    expect(sort).not.toBeNull();
    for (const label of expectedSortOptions) {
      expect(container.textContent).toContain(label);
    }

    act(() => {
      if (sort instanceof HTMLSelectElement) {
        sort.value = "gold_desc";
        sort.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(onSaveCard).not.toHaveBeenCalled();
    expect(container.querySelector('section[aria-label="할 일 lane"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="진행 중 lane"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="완료 lane"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("keeps board control state across board refreshes in the same component session", () => {
    const board = buildBoard();
    const { container, root, onSaveCard } = renderBoard({ board });

    const mineChip = container.querySelector('button[aria-label="내 업무"]');
    const search = container.querySelector('input[aria-label="업무 카드 검색"]');
    const sort = container.querySelector('select[aria-label="정렬"]');

    act(() => {
      mineChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (search instanceof HTMLInputElement) {
        search.value = "고객";
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (sort instanceof HTMLSelectElement) {
        sort.value = "recent";
        sort.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    act(() => {
      root.render(
        <Rt2DailyBoard
          board={{ ...board, cards: [...board.cards] }}
          pendingTodoIssueId={null}
          failedTodoIssueId={null}
          onSaveCard={onSaveCard}
        />,
      );
    });

    expect(mineChip?.getAttribute("aria-pressed")).toBe("true");
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect((search as HTMLInputElement).value).toBe("고객");
    expect(sort).toBeInstanceOf(HTMLSelectElement);
    expect((sort as HTMLSelectElement).value).toBe("recent");

    act(() => root.unmount());
  });

  it("preserves all lane groups and shows Korean active-filter empty text", () => {
    const { container, root } = renderBoard();
    const qualityChip = container.querySelector('button[aria-label="품질 이슈"]');

    act(() => {
      qualityChip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('section[aria-label="할 일 lane"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="진행 중 lane"]')).not.toBeNull();
    expect(container.querySelector('section[aria-label="완료 lane"]')).not.toBeNull();
    expect(container.textContent).toContain("완료에 조건과 맞는 카드가 없습니다.");
    expect(container.textContent).toContain("조건에 맞는 카드가 없습니다");
    expect(container.textContent).toContain("필터나 검색어를 줄이면 다른 업무 카드를 볼 수 있습니다.");

    act(() => root.unmount());
  });
});
