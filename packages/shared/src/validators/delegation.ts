import { z } from "zod";
import { DELEGATION_WAIT_TIMEOUT_MAX_SEC } from "../constants.js";

export const delegateRunSchema = z.object({
  targetAgentId: z.string().uuid(),
  task: z.string().trim().min(1).max(32000),
  /** What the child should deliver back; appended to the handoff so results come back structured. */
  expectedOutput: z.string().trim().min(1).max(4000).optional().nullable(),
  issueId: z.string().trim().min(1).optional().nullable(),
  createChildIssue: z.boolean().optional().default(true),
  childIssueTitle: z.string().trim().min(1).max(240).optional().nullable(),
  wait: z.boolean().optional().default(true),
  // Default below the max so out-of-the-box waits stay under common proxy
  // idle timeouts; callers can raise it explicitly up to the server cap.
  waitTimeoutSec: z.number().int().min(5).max(DELEGATION_WAIT_TIMEOUT_MAX_SEC).optional().default(120),
  /**
   * Client-supplied idempotency key. Retrying a delegate call with the same
   * key returns the existing child instead of spawning a duplicate.
   */
  clientKey: z.string().trim().min(1).max(255).optional().nullable(),
  /**
   * Multi-turn follow-up: resume the target agent's session from a previous
   * delegated child run owned by this agent (OpenCode-style persistent
   * subagent sessions). The new child continues the same adapter session.
   */
  followUpToChildRunId: z.string().uuid().optional().nullable(),
});

export type DelegateRunInput = z.infer<typeof delegateRunSchema>;

export const delegationWaitQuerySchema = z.object({
  /** Long-poll until every child of the run is terminal, up to this many seconds. */
  waitAllSec: z.coerce.number().int().min(1).max(DELEGATION_WAIT_TIMEOUT_MAX_SEC).optional(),
});
