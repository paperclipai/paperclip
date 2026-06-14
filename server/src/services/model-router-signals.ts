import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/** Kill-switch: router is opt-in. Default OFF for safe rollout. */
export function isModelRouterEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.PAPERCLIP_MODEL_ROUTER === "on";
}

/**
 * Error codes that mean "this issue spun / failed hard" on task complexity —
 * never downgrade such an issue to the fast model. Intentionally EXCLUDES infra
 * failures (`llm_unreachable`, `process_lost`): those reflect host/sleep/network
 * problems, not that the task was too hard for the model.
 */
const BLOCKING_ERROR_CODES = ["max_iterations", "timeout", "adapter_failed"];

/**
 * True if this issue produced a blocking error in the recent past. Drives the
 * anti-loop rule: a struggling issue must stay on the strong model.
 */
export async function hasBlockingErrorHistoryForIssue(input: {
  db: Db;
  companyId: string;
  issueId: string;
  sinceDaysAgo?: number;
}): Promise<boolean> {
  const days = input.sinceDaysAgo ?? 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await input.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        inArray(heartbeatRuns.errorCode, BLOCKING_ERROR_CODES),
        gt(heartbeatRuns.createdAt, cutoff),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
