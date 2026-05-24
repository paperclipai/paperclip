import { z } from "zod";
import { BRIEFING_QUALITY_LABELS, BRIEFING_QUALITY_DIMENSIONS } from "../types/briefing-quality.js";

export const briefingQualityLabelSchema = z.enum(BRIEFING_QUALITY_LABELS);
export const briefingQualityDimensionSchema = z.enum(BRIEFING_QUALITY_DIMENSIONS);

export const briefingDimensionScoreSchema = z.object({
  dimension: briefingQualityDimensionSchema,
  score: z.number().min(0).max(5),
  details: z.string(),
});

export const briefingGateResultSchema = z.object({
  gateId: z.string(),
  dimension: briefingQualityDimensionSchema,
  passed: z.boolean(),
  details: z.string(),
});

export const triggerBriefingQualityClassificationSchema = z.object({
  briefingId: z.string().min(1),
  briefing: z.object({
    overview: z.any(),
    weather: z.any(),
    notams: z.any(),
    route: z.any(),
    alerts: z.any(),
  }),
});

export type TriggerBriefingQualityClassification = z.infer<typeof triggerBriefingQualityClassificationSchema>;

export const briefingQualityClassificationResponseSchema = z.object({
  briefingId: z.string(),
  overallScore: z.number(),
  label: briefingQualityLabelSchema,
  dimensionScores: z.array(briefingDimensionScoreSchema),
  gateResults: z.array(briefingGateResultSchema),
  createdAt: z.string(),
});
