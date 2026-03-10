import { z } from "zod";

export const createCronJobSchema = z.object({
  agentId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional().default(true),
  cronExpr: z.string().min(1).max(200),
  timezone: z.string().optional().default("UTC"),
  staggerMs: z.number().int().nonnegative().max(300_000).optional().default(0),
  payload: z.record(z.unknown()).optional().default({}),
});

export type CreateCronJob = z.infer<typeof createCronJobSchema>;

export const updateCronJobSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  enabled: z.boolean().optional(),
  cronExpr: z.string().min(1).max(200).optional(),
  timezone: z.string().optional(),
  staggerMs: z.number().int().nonnegative().max(300_000).optional(),
  payload: z.record(z.unknown()).optional(),
});

export type UpdateCronJob = z.infer<typeof updateCronJobSchema>;

export const listCronJobsQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  enabled: z.enum(["true", "false"]).optional(),
});

export type ListCronJobsQuery = z.infer<typeof listCronJobsQuerySchema>;
