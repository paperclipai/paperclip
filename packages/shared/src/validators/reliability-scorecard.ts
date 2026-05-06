import { z } from "zod";
import { RELIABILITY_SCORECARD_STATUSES } from "../constants.js";

const ratioSchema = z.number().min(0).max(1);

export const reliabilityScorecardStatusSchema = z.enum(RELIABILITY_SCORECARD_STATUSES);

export const reliabilityScorecardWindowSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
}).strict();

export const reliabilityScorecardSummarySchema = z.object({
  status: reliabilityScorecardStatusSchema,
  controlPlaneReliability: ratioSchema,
  evidenceCompletenessRate: ratioSchema,
  manualRescueCount: z.number().int().nonnegative(),
}).strict();

export const reliabilityScorecardMetricSchema = z.object({
  key: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().trim().min(1).max(160),
  value: z.number().finite(),
  unit: z.string().trim().max(40).nullable().optional(),
}).strict();

export const reliabilityScorecardBlockerSchema = z.object({
  class: z.string().trim().min(1).max(120).regex(/^[a-z0-9][a-z0-9_-]*$/),
  count: z.number().int().nonnegative(),
  blockedMinutes: z.number().nonnegative().nullable().optional(),
}).strict();

export const reliabilityScorecardDocumentSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  companyId: z.string().uuid().nullable().optional(),
  window: reliabilityScorecardWindowSchema,
  summary: reliabilityScorecardSummarySchema,
  metrics: z.array(reliabilityScorecardMetricSchema).max(100).default([]),
  topBlockers: z.array(reliabilityScorecardBlockerSchema).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  const metricKeys = new Set<string>();
  for (const [index, metric] of value.metrics.entries()) {
    if (metricKeys.has(metric.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Reliability scorecard metric keys must be unique",
        path: ["metrics", index, "key"],
      });
    }
    metricKeys.add(metric.key);
  }
});

export type ReliabilityScorecardStatus = z.infer<typeof reliabilityScorecardStatusSchema>;
export type ReliabilityScorecardWindow = z.infer<typeof reliabilityScorecardWindowSchema>;
export type ReliabilityScorecardSummary = z.infer<typeof reliabilityScorecardSummarySchema>;
export type ReliabilityScorecardMetric = z.infer<typeof reliabilityScorecardMetricSchema>;
export type ReliabilityScorecardBlocker = z.infer<typeof reliabilityScorecardBlockerSchema>;
export type ReliabilityScorecardDocument = z.infer<typeof reliabilityScorecardDocumentSchema>;

export function formatReliabilityScorecardDocumentBody(document: unknown): string {
  const parsed = reliabilityScorecardDocumentSchema.parse(document);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function parseReliabilityScorecardDocumentBody(body: string): ReliabilityScorecardDocument {
  return reliabilityScorecardDocumentSchema.parse(JSON.parse(body));
}
