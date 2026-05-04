import { z } from "zod";
import { rt2BoardQualityStatusSchema, rt2DeliverableKindSchema } from "./rt2-task.js";

export const rt2DailyLaneSchema = z.enum(["todo", "doing", "done"]);
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

export const updateRt2DailyCardTitleSchema = z.object({
  title: z.string().trim().min(1).max(240),
});

export type UpdateRt2DailyCardTitle = z.infer<typeof updateRt2DailyCardTitleSchema>;

export const updateRt2DailyCardLaneSchema = z.object({
  lane: rt2DailyLaneSchema,
});

export type UpdateRt2DailyCardLane = z.infer<typeof updateRt2DailyCardLaneSchema>;

export const upsertRt2DailyCardDeliverableSchema = z.object({
  title: z.string().trim().min(1).max(240),
  type: rt2DeliverableKindSchema,
  required: z.boolean(),
  basePrice: z.number().int().min(0),
});

export type UpsertRt2DailyCardDeliverable = z.infer<typeof upsertRt2DailyCardDeliverableSchema>;

export const updateRt2DailyCardQualitySchema = z.object({
  qualityStatus: rt2BoardQualityStatusSchema,
});

export type UpdateRt2DailyCardQuality = z.infer<typeof updateRt2DailyCardQualitySchema>;

export const updateRt2DailyCardOkrSchema = z.object({
  goalId: z.string().uuid().nullable(),
});

export type UpdateRt2DailyCardOkr = z.infer<typeof updateRt2DailyCardOkrSchema>;

export const listRt2DailyBoardSchema = z.object({
  projectId: z.string().uuid(),
  reportDate: rt2DailyReportDateSchema,
});

export type ListRt2DailyBoard = z.infer<typeof listRt2DailyBoardSchema>;

export const queryRt2DailyWikiSchema = z.object({
  question: z.literal("오늘 뭐 했지?"),
});

export type QueryRt2DailyWiki = z.infer<typeof queryRt2DailyWikiSchema>;
