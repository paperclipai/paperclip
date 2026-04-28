import { z } from "zod";

export const rt2DailyLaneSchema = z.enum(["today", "support_1", "support_2"]);
const rt2DailyReportDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isValidCalendarDate(value: string): boolean {
  if (!rt2DailyReportDatePattern.test(value)) {
    return false;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

export const rt2DailyReportDateSchema = z.string().regex(rt2DailyReportDatePattern).refine(isValidCalendarDate);

export const upsertRt2DailyReportCardSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
  lane: rt2DailyLaneSchema,
  bucketLabel: z.string().trim().max(40).nullable().optional(),
  progressPercent: z.number().int().min(0).max(100),
  note: z.string().trim().max(500).nullable().optional(),
});

export type UpsertRt2DailyReportCard = z.infer<typeof upsertRt2DailyReportCardSchema>;

export const listRt2DailyBoardSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
});

export type ListRt2DailyBoard = z.infer<typeof listRt2DailyBoardSchema>;

export const queryRt2DailyWikiSchema = z.object({
  question: z.literal("오늘 뭐 했지?"),
});

export type QueryRt2DailyWiki = z.infer<typeof queryRt2DailyWikiSchema>;
