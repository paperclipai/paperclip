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

  it("exports narrow quick-edit validators for title, deliverable, quality, and OKR updates", () => {
    const exportsByName = sharedExports as Record<string, any>;

    expect(exportsByName.updateRt2DailyCardTitleSchema).toBeDefined();
    expect(exportsByName.upsertRt2DailyCardDeliverableSchema).toBeDefined();
    expect(exportsByName.updateRt2DailyCardQualitySchema).toBeDefined();
    expect(exportsByName.updateRt2DailyCardOkrSchema).toBeDefined();

    expect(() => exportsByName.updateRt2DailyCardTitleSchema.parse({ title: "" })).toThrow();
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
  });
});
