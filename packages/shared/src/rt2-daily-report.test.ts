import { describe, expect, it } from "vitest";
import type { Rt2DailyActivityEntry, Rt2DailyBoard, Rt2DailyLane, Rt2DailyWikiAnswer } from "./types/index.js";
import {
  LIVE_EVENT_TYPES,
  listRt2DailyBoardSchema,
  rt2DailyReportDateSchema,
  queryRt2DailyWikiSchema,
  rt2DailyLaneSchema,
  upsertRt2DailyReportCardSchema,
} from "./index.js";
import {
  listRt2DailyBoardSchema as validatorsListRt2DailyBoardSchema,
  queryRt2DailyWikiSchema as validatorsQueryRt2DailyWikiSchema,
  rt2DailyLaneSchema as validatorsRt2DailyLaneSchema,
  rt2DailyReportDateSchema as validatorsRt2DailyReportDateSchema,
} from "./validators/index.js";
import * as sharedExports from "./index.js";

type DailyTypeSmoke = [Rt2DailyLane, Rt2DailyBoard, Rt2DailyWikiAnswer, Rt2DailyActivityEntry];
const evidenceTagSmoke: Rt2DailyActivityEntry["evidenceTag"][] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];
void evidenceTagSmoke;

describe("RT2 daily report shared contracts", () => {
  it("accepts todo/doing/done lanes and rejects legacy or unknown lanes", () => {
    expect(rt2DailyLaneSchema.parse("todo")).toBe("todo");
    expect(rt2DailyLaneSchema.parse("doing")).toBe("doing");
    expect(rt2DailyLaneSchema.parse("done")).toBe("done");
    expect(() => rt2DailyLaneSchema.parse("today")).toThrow();
    expect(() => rt2DailyLaneSchema.parse("archive")).toThrow();
  });

  it("rejects progressPercent above 100", () => {
    expect(() =>
      upsertRt2DailyReportCardSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        reportDate: "2026-04-17",
        lane: "todo",
        progressPercent: 120,
      }),
    ).toThrow();
  });

  it("rejects impossible calendar dates", () => {
    expect(() => rt2DailyReportDateSchema.parse("2026-02-31")).toThrow();
    expect(rt2DailyReportDateSchema.parse("2026-02-28")).toBe("2026-02-28");
  });

  it("accepts the board query shape", () => {
    expect(
      listRt2DailyBoardSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        reportDate: "2026-04-17",
      }),
    ).toEqual({
      projectId: "550e8400-e29b-41d4-a716-446655440000",
      reportDate: "2026-04-17",
    });
  });

  it('accepts only the question literal "오늘 뭐 했지?"', () => {
    expect(queryRt2DailyWikiSchema.parse({ question: "오늘 뭐 했지?" })).toEqual({
      question: "오늘 뭐 했지?",
    });
    expect(() =>
      queryRt2DailyWikiSchema.parse({ question: "what did I do?" }),
    ).toThrow();
  });

  it("includes RT2 daily report live event types", () => {
    expect(LIVE_EVENT_TYPES).toEqual(
      expect.arrayContaining(["rt2.daily-report.updated", "rt2.daily-wiki.updated"]),
    );
  });

  it("re-exports daily-report validators from the direct barrel", () => {
    expect(validatorsRt2DailyLaneSchema).toBe(rt2DailyLaneSchema);
    expect(validatorsRt2DailyReportDateSchema).toBe(rt2DailyReportDateSchema);
    expect(validatorsListRt2DailyBoardSchema).toBe(listRt2DailyBoardSchema);
    expect(validatorsQueryRt2DailyWikiSchema).toBe(queryRt2DailyWikiSchema);
  });

  it("exposes enriched daily card metadata required for quick edit and board controls", () => {
    const contract: Rt2DailyBoard["cards"][number] = {
      taskIssueId: "550e8400-e29b-41d4-a716-446655440010",
      todoIssueId: "550e8400-e29b-41d4-a716-446655440011",
      taskTitle: "운영 리듬 만들기",
      todoTitle: "고객 리포트 정리",
      assigneeUserId: "550e8400-e29b-41d4-a716-446655440012",
      reportDate: "2026-04-30",
      lane: "doing",
      bucketLabel: "오전",
      progressPercent: 60,
      note: "초안 검토 중",
      status: "in_review",
      updatedAt: new Date("2026-04-30T09:30:00.000Z"),
      deliverableCount: 1,
      submittedDeliverableCount: 0,
      taskDeliverableCount: 0,
      deliverableTitle: "주간 보고서",
      deliverableType: "document",
      deliverableRequired: true,
      deliverableOwner: "todo",
      deliverableSource: "todo",
      deliverableId: "550e8400-e29b-41d4-a716-446655440013",
      deliverableMissing: false,
      basePriceTotal: 120000,
      qualityStatus: "needs_work",
      approvalWaiting: true,
      approvalWaitingSource: "deliverable_review",
      okrContextStatus: "connected",
      okrSource: "direct_task",
      directGoalId: "550e8400-e29b-41d4-a716-446655440001",
      directGoalTitle: "운영 리듬 개선",
      inheritedGoalId: null,
      inheritedGoalTitle: null,
      reportDateMatchesBoard: true,
      actorMatchesAssignee: true,
      assigneeDisplayName: "김운영",
      searchText: "주간 보고서 김운영 운영 리듬 개선 수정 필요",
      searchableLabels: ["주간 보고서", "김운영", "운영 리듬 개선", "수정 필요"],
      dueDate: "2026-04-30",
      gapFlags: [],
    };

    expect(contract).toEqual(
      expect.objectContaining({
        deliverableTitle: expect.any(String),
        deliverableType: "document",
        deliverableRequired: true,
        deliverableOwner: "todo",
        basePriceTotal: 120000,
        qualityStatus: "needs_work",
        approvalWaiting: true,
        approvalWaitingSource: "deliverable_review",
        okrSource: "direct_task",
        directGoalTitle: "운영 리듬 개선",
        inheritedGoalTitle: null,
        reportDateMatchesBoard: true,
        actorMatchesAssignee: true,
        assigneeDisplayName: "김운영",
        searchText: expect.stringContaining("수정 필요"),
        searchableLabels: expect.arrayContaining(["주간 보고서", "수정 필요"]),
        dueDate: "2026-04-30",
      }),
    );
  });

  it("models Mission to To-Do hierarchy rollup inside the daily cockpit contract", () => {
    const board: Rt2DailyBoard = {
      companyId: "550e8400-e29b-41d4-a716-446655440020",
      projectId: "550e8400-e29b-41d4-a716-446655440021",
      userId: "550e8400-e29b-41d4-a716-446655440022",
      reportDate: "2026-05-01",
      cards: [],
      cockpit: {
        summary: {
          tasksWorked: 1,
          todosCompleted: 1,
          deliverablesDefined: 1,
          deliverablesSubmitted: 1,
          effortNoteCount: 1,
          goldImpact: 50,
          xpImpact: 30,
          qualityStatus: "reviewed",
        },
        traceRows: [],
        hierarchyRows: [
          {
            taskIssueId: "550e8400-e29b-41d4-a716-446655440030",
            todoIssueId: "550e8400-e29b-41d4-a716-446655440031",
            path: [
              {
                id: "550e8400-e29b-41d4-a716-446655440023",
                kind: "mission",
                title: "RealTycoon2 운영 리듬",
                status: "active",
                parentId: null,
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440024",
                kind: "objective",
                title: "Daily cockpit 정착",
                status: "active",
                parentId: "550e8400-e29b-41d4-a716-446655440023",
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440025",
                kind: "key_result",
                title: "업무 추적 완료율 90%",
                status: "active",
                parentId: "550e8400-e29b-41d4-a716-446655440024",
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440021",
                kind: "project",
                title: "운영 자동화",
                status: "in_progress",
                parentId: "550e8400-e29b-41d4-a716-446655440025",
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440030",
                kind: "task",
                title: "리포트 루프 정착",
                status: "done",
                parentId: "550e8400-e29b-41d4-a716-446655440021",
              },
              {
                id: "550e8400-e29b-41d4-a716-446655440031",
                kind: "todo",
                title: "오늘 리포트 제출",
                status: "done",
                parentId: "550e8400-e29b-41d4-a716-446655440030",
              },
            ],
            rollup: {
              status: "done",
              progressPercent: 100,
              deliverableCount: 1,
              submittedDeliverableCount: 1,
              goldImpact: 50,
              gapFlags: [],
            },
          },
        ],
        gapFlags: [],
        aiSummary: ["Mission부터 To-Do까지 rollup이 연결되었습니다."],
      },
    };

    expect(board.cockpit.hierarchyRows[0]?.path.map((node) => node.kind)).toEqual([
      "mission",
      "objective",
      "key_result",
      "project",
      "task",
      "todo",
    ]);
    expect(board.cockpit.hierarchyRows[0]?.rollup).toEqual(expect.objectContaining({
      status: "done",
      progressPercent: 100,
      deliverableCount: 1,
    }));
  });

  it("exports narrow quick-edit validators for title, lane, deliverable, quality, and OKR updates", () => {
    const exportsByName = sharedExports as Record<string, any>;

    expect(exportsByName.updateRt2DailyCardTitleSchema).toBeDefined();
    expect(exportsByName.updateRt2DailyCardLaneSchema).toBeDefined();
    expect(exportsByName.upsertRt2DailyCardDeliverableSchema).toBeDefined();
    expect(exportsByName.updateRt2DailyCardQualitySchema).toBeDefined();
    expect(exportsByName.updateRt2DailyCardOkrSchema).toBeDefined();

    expect(() => exportsByName.updateRt2DailyCardTitleSchema.parse({ title: "" })).toThrow();
    expect(() => exportsByName.updateRt2DailyCardLaneSchema.parse({ lane: "today" })).toThrow();
    expect(() =>
      exportsByName.upsertRt2DailyCardDeliverableSchema.parse({
        title: "",
        type: "spreadsheet",
        required: true,
        basePrice: -1,
      }),
    ).toThrow();
    expect(() => exportsByName.updateRt2DailyCardQualitySchema.parse({ qualityStatus: "approved" })).toThrow();
    expect(() => exportsByName.updateRt2DailyCardOkrSchema.parse({ goalId: "not-a-uuid" })).toThrow();

    expect(exportsByName.updateRt2DailyCardTitleSchema.parse({ title: "고객 리포트 정리" })).toEqual({
      title: "고객 리포트 정리",
    });
    expect(exportsByName.updateRt2DailyCardLaneSchema.parse({ lane: "done" })).toEqual({
      lane: "done",
    });
    expect(
      exportsByName.upsertRt2DailyCardDeliverableSchema.parse({
        title: "고객 리포트",
        type: "document",
        required: true,
        basePrice: 50000,
      }),
    ).toEqual({
      title: "고객 리포트",
      type: "document",
      required: true,
      basePrice: 50000,
    });
    expect(exportsByName.updateRt2DailyCardQualitySchema.parse({ qualityStatus: "needs_work" })).toEqual({
      qualityStatus: "needs_work",
    });
    expect(
      exportsByName.updateRt2DailyCardOkrSchema.parse({
        goalId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toEqual({
      goalId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(exportsByName.updateRt2DailyCardOkrSchema.parse({ goalId: null })).toEqual({
      goalId: null,
    });
  });
});
