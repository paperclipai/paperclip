import { z } from "zod";
import { DELEGATION_WAIT_TIMEOUT_MAX_SEC } from "../constants.js";

export const delegateRunSchema = z.object({
  targetAgentId: z.string().uuid(),
  task: z.string().trim().min(1).max(32000),
  issueId: z.string().trim().min(1).optional().nullable(),
  createChildIssue: z.boolean().optional().default(true),
  childIssueTitle: z.string().trim().min(1).max(240).optional().nullable(),
  wait: z.boolean().optional().default(true),
  // Default below the max so out-of-the-box waits stay under common proxy
  // idle timeouts; callers can raise it explicitly up to the server cap.
  waitTimeoutSec: z.number().int().min(5).max(DELEGATION_WAIT_TIMEOUT_MAX_SEC).optional().default(120),
});

export type DelegateRunInput = z.infer<typeof delegateRunSchema>;
