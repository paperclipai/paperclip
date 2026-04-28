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

type DailyTypeSmoke = [Rt2DailyLane, Rt2DailyBoard, Rt2DailyWikiAnswer, Rt2DailyActivityEntry];
const evidenceTagSmoke: Rt2DailyActivityEntry["evidenceTag"][] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];
void evidenceTagSmoke;

describe("RT2 daily report shared contracts", () => {
  it("accepts today/support_1/support_2 lanes and rejects archive", () => {
    expect(rt2DailyLaneSchema.parse("today")).toBe("today");
    expect(rt2DailyLaneSchema.parse("support_1")).toBe("support_1");
    expect(rt2DailyLaneSchema.parse("support_2")).toBe("support_2");
    expect(() => rt2DailyLaneSchema.parse("archive")).toThrow();
  });

  it("rejects progressPercent above 100", () => {
    expect(() =>
      upsertRt2DailyReportCardSchema.parse({
        projectId: "550e8400-e29b-41d4-a716-446655440000",
        reportDate: "2026-04-17",
        lane: "today",
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
});
