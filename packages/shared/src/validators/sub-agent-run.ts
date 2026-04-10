import { z } from "zod";

export const createSubAgentRunSchema = z.object({
  subAgentId: z.string().uuid(),
  leaderAgentId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional().nullable(),
  task: z.string().min(1),
});

export type CreateSubAgentRun = z.infer<typeof createSubAgentRunSchema>;

export const completeSubAgentRunSchema = z.object({
  status: z.enum(["completed", "failed"]),
  result: z.string().optional().nullable(),
});

export type CompleteSubAgentRun = z.infer<typeof completeSubAgentRunSchema>;

export const rateSubAgentRunSchema = z.object({
  rating: z.enum(["thumbs_up", "thumbs_down"]),
});

export type RateSubAgentRun = z.infer<typeof rateSubAgentRunSchema>;
