// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Rt2CaptureQueue, Rt2CaptureReliabilityReport, Rt2DailyBoard as Rt2DailyBoardData } from "@paperclipai/shared";

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
        hierarchyRows: [
          {
            taskIssueId: "task-1",
            todoIssueId: "todo-1",
            path: [
              {
                id: "goal-1",
                kind: "objective",
                title: "운영 리듬 개선",
                status: "active",
                parentId: null,
              },
              {
                id: "project-1",
                kind: "project",
                title: "운영 자동화",
                status: "in_progress",
                parentId: "goal-1",
              },
              {
                id: "task-1",
                kind: "task",
                title: "주간 운영 리포트",
                status: "in_progress",
                parentId: "project-1",
              },
              {
                id: "todo-1",
                kind: "todo",
                title: "고객 리포트 정리",
                status: "in_progress",
                parentId: "task-1",
              },
            ],
            rollup: {
              status: "in_progress",
              progressPercent: 20,
              deliverableCount: 0,
              submittedDeliverableCount: 0,
              goldImpact: 0,
              gapFlags: ["missing_deliverable"],
            },
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
          captureQueue={props.captureQueue ?? null}
          captureReliabilityReport={props.captureReliabilityReport ?? null}
          pendingCaptureDraftId={props.pendingCaptureDraftId ?? null}
          onPromoteCaptureDraft={props.onPromoteCaptureDraft}
          onFailCaptureDraft={props.onFailCaptureDraft}
          onReviseCaptureDraft={props.onReviseCaptureDraft}
          onTransitionCaptureDraft={props.onTransitionCaptureDraft}
        />,
      );
    });

    return { container, root, onSaveCard, board };
  }

  function buildCaptureQueue(): Rt2CaptureQueue {
    return {
      companyId: "company-1",
      sources: [],
      summary: {
        reviewRequired: 1,
        duplicate: 1,
        permissionBlocked: 0,
        failed: 0,
        promoted: 0,
      },
      drafts: [
        {
          id: "draft-1",
          companyId: "company-1",
          source: "web",
          channel: "daily-work:project-1",
          externalUserId: null,
          rawText: "task: 제안서 검수; deliverable: 검수 메모; price: 120000",
          parsedDraft: {
            taskTitle: "제안서 검수",
            todoTitle: "가격표 확인",
            deliverableTitle: "검수 메모",
            basePrice: 120000,
            taskMode: "solo",
            capacity: 1,
          },
          status: "review_required",
          promotionTarget: null,
          promotedIssueId: null,
          promotedWorkProductId: null,
          duplicateOfDraftId: null,
          failureCode: null,
          failureMessage: null,
          permissionStatus: "allowed",
          sourceEvidence: {
            sourceInstallationId: null,
            installationState: "not_installed",
            signingStatus: "unsigned",
            eventId: "evt-web-1",
            eventTimestamp: "2026-04-30T00:00:00.000Z",
            reasonCode: null,
          },
          semanticContext: [],
          duplicateWarning: null,
          auditTrail: [],
          latestRevision: {
            id: "revision-1",
            draftId: "draft-1",
            companyId: "company-1",
            revisionNumber: 1,
            snapshot: {
              taskTitle: "제안서 검수",
              todoTitle: "가격표 확인",
              deliverableTitle: "검수 메모",
              basePrice: 120000,
              taskMode: "solo",
              capacity: 1,
            },
            changeSummary: "Initial capture parse",
            createdByUserId: "user-1",
            createdAt: new Date("2026-04-30T00:00:00.000Z"),
          },
          createdAt: new Date("2026-04-30T00:00:00.000Z"),
          updatedAt: new Date("2026-04-30T00:00:00.000Z"),
        },
        {
          id: "draft-2",
          companyId: "company-1",
          source: "native",
          channel: "mobile",
          externalUserId: "user-native",
          rawText: "task: 제안서 검수; deliverable: 검수 메모; price: 120000",
          parsedDraft: {
            taskTitle: "제안서 검수",
            deliverableTitle: "검수 메모",
            basePrice: 120000,
          },
          status: "duplicate",
          promotionTarget: null,
          promotedIssueId: null,
          promotedWorkProductId: null,
          duplicateOfDraftId: "draft-1",
          failureCode: null,
          failureMessage: null,
          permissionStatus: "allowed",
          sourceEvidence: {
            sourceInstallationId: null,
            installationState: "not_installed",
            signingStatus: "unsigned",
            eventId: "evt-native-1",
            eventTimestamp: "2026-04-30T00:01:00.000Z",
            reasonCode: null,
          },
          semanticContext: [],
          duplicateWarning: "Potential duplicate of capture draft draft-1",
          auditTrail: [],
          latestRevision: null,
          createdAt: new Date("2026-04-30T00:01:00.000Z"),
          updatedAt: new Date("2026-04-30T00:01:00.000Z"),
        },
      ],
    };
  }

  function buildReliabilityReport(): Rt2CaptureReliabilityReport {
    return {
      companyId: "company-1",
      generatedAt: new Date("2026-04-30T00:05:00.000Z"),
      totals: {
        draftCount: 3,
        reviewRequiredCount: 1,
        revisedCount: 1,
        duplicateCount: 1,
        failureCount: 1,
        permissionBlockedCount: 1,
        promotedCount: 1,
        retryCount: 2,
        averagePromotionLatencyMinutes: 12,
        maxPromotionLatencyMinutes: 18,
      },
      rows: [
        {
          source: "web",
          label: "Web",
          draftCount: 1,
          reviewRequiredCount: 0,
          revisedCount: 1,
          duplicateCount: 0,
          failureCount: 0,
          permissionBlockedCount: 0,
          promotedCount: 1,
          retryCount: 0,
          averagePromotionLatencyMinutes: 12,
          maxPromotionLatencyMinutes: 18,
        },
        {
          source: "slack",
          label: "Slack Ops",
          draftCount: 1,
          reviewRequiredCount: 0,
          revisedCount: 0,
          duplicateCount: 0,
          failureCount: 1,
          permissionBlockedCount: 1,
          promotedCount: 0,
          retryCount: 2,
          averagePromotionLatencyMinutes: null,
          maxPromotionLatencyMinutes: null,
        },
      ],
    };
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
              hierarchyRows: [
                {
                  taskIssueId: "task-1",
                  todoIssueId: "todo-1",
                  path: [
                    {
                      id: "goal-1",
                      kind: "objective",
                      title: "운영 리듬 개선",
                      status: "active",
                      parentId: null,
                    },
                    {
                      id: "project-1",
                      kind: "project",
                      title: "운영 자동화",
                      status: "in_progress",
                      parentId: "goal-1",
                    },
                    {
                      id: "task-1",
                      kind: "task",
                      title: "주간 보고",
                      status: "in_progress",
                      parentId: "project-1",
                    },
                    {
                      id: "todo-1",
                      kind: "todo",
                      title: "주간 보고서 작성",
                      status: "in_progress",
                      parentId: "task-1",
                    },
                  ],
                  rollup: {
                    status: "in_progress",
                    progressPercent: 30,
                    deliverableCount: 1,
                    submittedDeliverableCount: 0,
                    goldImpact: 10,
                    gapFlags: [],
                  },
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
    expect(container.textContent).toContain("OKR 트리 · Mission -> To-Do");
    expect(container.textContent).toContain("Objective");
    expect(container.textContent).toContain("Project");
    expect(container.textContent).toContain("진행 30% · 산출물 1개 · 제출 0개");
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

  it("shows One-Liner capture drafts with duplicate warning and source evidence from the board", () => {
    const onPromoteCaptureDraft = vi.fn();
    const onFailCaptureDraft = vi.fn();
    const { container, root } = renderBoard({
      captureQueue: buildCaptureQueue(),
      onPromoteCaptureDraft,
      onFailCaptureDraft,
    });

    expect(container.textContent).toContain("One-Liner 보드 검수함");
    expect(container.textContent).toContain("검수 필요 1");
    expect(container.textContent).toContain("중복 의심 1");
    expect(container.textContent).toContain("제안서 검수");
    expect(container.textContent).toContain("검수 메모");
    expect(container.textContent).toContain("evt-web-1");
    expect(container.textContent).toContain("Potential duplicate of capture draft draft-1");

    const approveButtons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.includes("Task로 승인"));
    const holdButtons = Array.from(container.querySelectorAll("button")).filter((button) => button.textContent?.includes("보류"));

    act(() => {
      approveButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      holdButtons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onPromoteCaptureDraft).toHaveBeenCalledWith("draft-1");
    expect(onFailCaptureDraft).toHaveBeenCalledWith("draft-2", "중복 초안으로 보류");

    act(() => root.unmount());
  });

  it("distinguishes messaging duplicate, signature, and malformed failures", () => {
    const queue = buildCaptureQueue();
    const base = queue.drafts[0]!;
    queue.summary = {
      reviewRequired: 0,
      duplicate: 1,
      permissionBlocked: 1,
      failed: 1,
      promoted: 0,
    };
    queue.drafts = [
      {
        ...base,
        id: "draft-slack-duplicate",
        source: "slack",
        status: "duplicate",
        duplicateOfDraftId: "draft-original",
        duplicateWarning: "Potential duplicate of capture draft draft-original",
        sourceEvidence: {
          ...base.sourceEvidence!,
          signingStatus: "signed",
          eventId: "evt-dup",
          metadata: { channel: "C-sales", externalUserId: "U-sales" },
        },
      },
      {
        ...base,
        id: "draft-slack-signature",
        source: "slack",
        status: "permission_blocked",
        permissionStatus: "blocked",
        duplicateOfDraftId: null,
        duplicateWarning: null,
        sourceEvidence: {
          ...base.sourceEvidence!,
          signingStatus: "invalid",
          reasonCode: "signature_invalid",
          eventId: "evt-invalid",
          metadata: { channel: "C-ops", externalUserId: "U-ops" },
        },
      },
      {
        ...base,
        id: "draft-webhook-malformed",
        source: "webhook",
        status: "failed",
        failureCode: "parse_error",
        failureMessage: "Messaging payload did not include capture text.",
        duplicateOfDraftId: null,
        duplicateWarning: null,
        sourceEvidence: {
          ...base.sourceEvidence!,
          signingStatus: "unsigned",
          reasonCode: "malformed_payload",
          eventId: "evt-bad",
          metadata: { provider: "webhook", eventId: "evt-bad" },
        },
      },
    ];

    const { container, root } = renderBoard({ captureQueue: queue });

    expect(container.textContent).toContain("중복 의심");
    expect(container.textContent).toContain("서명 오류");
    expect(container.textContent).toContain("형식 오류");
    expect(container.textContent).toContain("메시징 근거");
    expect(container.textContent).toContain("channel: C-ops");
    expect(container.textContent).toContain("provider: webhook");

    act(() => root.unmount());
  });

  it("filters capture drafts and renders reliability report with promoted evidence links", () => {
    const queue = buildCaptureQueue();
    const base = queue.drafts[0]!;
    queue.sources = [
      {
        id: "source-web",
        companyId: "company-1",
        source: "web",
        label: "Web",
        installationState: "installed",
        signingStatus: "unsigned",
        lastInboundEventAt: null,
        lastInboundEventId: null,
        lastErrorCode: null,
        blockedReason: null,
        updatedAt: new Date("2026-04-30T00:00:00.000Z"),
      },
      {
        id: "source-slack",
        companyId: "company-1",
        source: "slack",
        label: "Slack Ops",
        installationState: "installed",
        signingStatus: "signed",
        lastInboundEventAt: null,
        lastInboundEventId: null,
        lastErrorCode: "signature_invalid",
        blockedReason: null,
        updatedAt: new Date("2026-04-30T00:00:00.000Z"),
      },
    ];
    queue.summary = {
      reviewRequired: 0,
      duplicate: 0,
      permissionBlocked: 1,
      failed: 0,
      promoted: 1,
    };
    queue.drafts = [
      {
        ...base,
        id: "draft-promoted",
        status: "promoted",
        promotionTarget: "task",
        promotedIssueId: "12345678-1234-4234-9234-123456789012",
        latestRevision: {
          ...base.latestRevision!,
          id: "revision-2",
          revisionNumber: 2,
        },
      },
      {
        ...base,
        id: "draft-slack-failed",
        source: "slack",
        status: "permission_blocked",
        permissionStatus: "blocked",
        parsedDraft: {
          taskTitle: "Slack 서명 실패",
          deliverableTitle: "오류 근거",
          basePrice: 1000,
        },
        latestRevision: null,
        sourceEvidence: {
          ...base.sourceEvidence!,
          signingStatus: "invalid",
          reasonCode: "signature_invalid",
          eventId: "evt-slack-invalid",
          metadata: { retryCount: "2" },
        },
      },
    ];

    const { container, root } = renderBoard({
      captureQueue: queue,
      captureReliabilityReport: buildReliabilityReport(),
    });

    expect(container.textContent).toContain("입력 신뢰도 리포트");
    expect(container.textContent).toContain("Slack Ops");
    expect(container.textContent).toContain("승인 지연 평균 12분");
    expect(container.textContent).toContain("원본 초안 근거");
    expect(container.textContent).toContain("생성된 Task 보기 12345678");

    const sourceFilter = container.querySelector('select[aria-label="검수함 출처 필터"]');
    act(() => {
      if (sourceFilter instanceof HTMLSelectElement) {
        sourceFilter.value = "slack";
        sourceFilter.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    expect(container.textContent).toContain("Slack 서명 실패");
    expect(container.textContent).not.toContain("생성된 Task 보기 12345678");

    const failedSync = container.querySelector('button[aria-label="검수함 전송 실패 필터"]');
    expect(failedSync).not.toBeNull();
    expect(failedSync?.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      failedSync?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(failedSync?.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("서명 오류");

    act(() => root.unmount());
  });

  it("reopens capture drafts for revision edits and review state actions", () => {
    const onReviseCaptureDraft = vi.fn();
    const onTransitionCaptureDraft = vi.fn();
    const { container, root } = renderBoard({
      captureQueue: buildCaptureQueue(),
      onReviseCaptureDraft,
      onTransitionCaptureDraft,
    });

    expect(container.textContent).toContain("수정 이력 v1");

    const reopenButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("다시 열기"));
    act(() => {
      reopenButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[aria-label="draft-1-revision-editor"]')).not.toBeNull();
    expect(container.textContent).toContain("초안 수정");
    expect(container.textContent).toContain("수정 저장");
    expect(container.textContent).toContain("재검토 요청");
    expect(container.textContent).toContain("반려");

    const titleInput = container.querySelector('[aria-label="draft-1-revision-editor"] input') as HTMLInputElement | null;
    act(() => {
      if (!titleInput) return;
      titleInput.value = "수정된 제안서 검수";
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("수정 저장"));
    const requestButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("재검토 요청"));
    const rejectButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("반려"));

    act(() => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      requestButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      rejectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onReviseCaptureDraft).toHaveBeenCalledWith("draft-1", expect.objectContaining({
      snapshot: expect.objectContaining({
        taskTitle: "수정된 제안서 검수",
        deliverableTitle: "검수 메모",
        basePrice: 120000,
      }),
    }));
    expect(onTransitionCaptureDraft).toHaveBeenCalledWith("draft-1", { action: "request_revision", reason: "추가 재검토 요청" });
    expect(onTransitionCaptureDraft).toHaveBeenCalledWith("draft-1", { action: "reject", reason: "보드 검수에서 반려" });

    act(() => root.unmount());
  });

  it("shows Jarvis, wiki, graph, and economy as compact support evidence", () => {
    const { container, root } = renderBoard();

    expect(container.querySelector('aside[aria-label="보조 근거"]')).not.toBeNull();
    expect(container.textContent).toContain("보조 근거");
    expect(container.textContent).toContain("Jarvis 추천");
    expect(container.textContent).toContain("지식 근거");
    expect(container.textContent).toContain("그래프 연결");
    expect(container.textContent).toContain("경제 근거");
    expect(container.textContent).toContain("오늘 위키와 카드 메모에 연결된 업무");
    expect(container.textContent).toContain("OKR/KPI 추적 노드");
    expect(container.textContent).toContain("가격 또는 제출 근거가 있는 카드");
    expect(container.querySelector('[aria-label="경제 근거 링크"]')?.textContent).toContain("정산/P&L");
    expect(container.querySelector('[aria-label="경제 근거 링크"]')?.textContent).toContain("Jarvis 마켓");
    expect(container.querySelector('a[href="/pnl"]')).not.toBeNull();
    expect(container.querySelector('a[href="/marketplace"]')).not.toBeNull();
    expect(container.querySelector('a[href="/agents"]')?.textContent).toContain("CareerMate");
    expect(container.querySelector('[aria-label="todo-1-support-evidence"]')?.textContent).toContain("보완 필요 항목 확인");
    expect(container.querySelector('[aria-label="todo-2-support-evidence"]')?.textContent).toContain("90,000 Gold 근거");
    expect(container.textContent).not.toContain("Task Mesh");
    expect(container.textContent).not.toContain("Paper Company");
    expect(container.textContent).not.toContain("No graph data available");

    act(() => root.unmount());
  });
});
