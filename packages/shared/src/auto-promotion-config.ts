/**
 * Plan 4 - shared zod schemas + types for auto-promotion config, list queries, and revert input.
 * Consumed by both the route layer (request validation) and the service layer (patch validation).
 */
import { z } from "zod";

export const autoPromotionConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  scanHourUtc: z.number().int().min(0).max(23).optional(),
  minUses: z.number().int().min(3).optional(),
  minSuccessRatio: z.number().min(0.6).max(1.0).optional(),
  minAgeHours: z.number().int().min(6).optional(),
  minBodyStableHours: z.number().int().min(6).optional(),
  minDistinctRuns: z.number().int().min(2).optional(),
  maxPromotionsPerTick: z.number().int().min(1).max(20).optional(),
});

export type AutoPromotionConfigPatch = z.infer<typeof autoPromotionConfigPatchSchema>;

export const autoPromotionListQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  revertedOnly: z.coerce.boolean().optional().default(false),
  neverReviewed: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(200).optional().default(20),
});

export type AutoPromotionListQuery = z.infer<typeof autoPromotionListQuerySchema>;

export const autoPromotionRevertSchema = z.object({
  reason: z.string().min(1).max(2000),
});

export type AutoPromotionRevertInput = z.infer<typeof autoPromotionRevertSchema>;
