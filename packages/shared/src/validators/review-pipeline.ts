import { z } from "zod";

export const reviewStepConfigSchema = z.object({
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(100),
  type: z.enum(["auto", "manual"]),
  executor: z.enum(["codex", "claude", "builtin", "manual"]),
  config: z.record(z.unknown()).optional().default({}),
});

export const updateReviewPipelineSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  steps: z.array(reviewStepConfigSchema).optional(),
});

export const rejectReviewSchema = z.object({
  decisionNote: z.string().min(1).max(5000),
});

export const updateReviewCheckSchema = z.object({
  status: z.enum(["passed", "failed", "skipped"]),
  summary: z.string().max(5000).optional(),
});

export type ReviewStepConfig = z.infer<typeof reviewStepConfigSchema>;
export type UpdateReviewPipeline = z.infer<typeof updateReviewPipelineSchema>;

export const REVIEW_RUN_STATUSES = ["running", "passed", "failed", "cancelled"] as const;
export type ReviewRunStatus = (typeof REVIEW_RUN_STATUSES)[number];

export const REVIEW_CHECK_STATUSES = ["pending", "running", "passed", "failed", "skipped"] as const;
export type ReviewCheckStatus = (typeof REVIEW_CHECK_STATUSES)[number];
