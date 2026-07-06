import { z } from "zod";

export const delegateRunSchema = z.object({
  targetAgentId: z.string().uuid(),
  task: z.string().trim().min(1).max(32000),
  issueId: z.string().trim().min(1).optional().nullable(),
  createChildIssue: z.boolean().optional().default(true),
  childIssueTitle: z.string().trim().min(1).max(240).optional().nullable(),
  wait: z.boolean().optional().default(true),
  waitTimeoutSec: z.number().int().min(5).max(300).optional().default(300),
});

export type DelegateRunInput = z.infer<typeof delegateRunSchema>;
