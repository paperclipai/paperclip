import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * A heartbeat run's source issue is normally set at wake time, from the wake
 * that named an issue. A run that was started without one — a manually invoked
 * heartbeat, or any wake that carried no issue — has `contextSnapshot.issueId`
 * null for its whole life.
 *
 * Since `CROSS_ISSUE_INFLUENCE_ENFORCE_AT`, that is no longer a soft state:
 * `observeCrossIssueInfluence` throws on a null source issue *before* it
 * compares source against target, so such a run is refused on every issue write
 * it attempts — including writes to an issue assigned to its own agent. The
 * agent works, cannot report, and the board never moves.
 *
 * Checking an issue out is the run declaring what it is working on, so it is
 * the natural place to acquire a source issue. When an agent checks out an
 * issue *as itself* using its own run, no wake is sent (there is nobody to
 * wake), which is exactly the case that previously left the run unscoped.
 */
export type AdoptRunSourceIssueInput = {
  actorType: "board" | "agent" | "none";
  actorAgentId: string | null;
  checkoutAgentId: string;
  checkoutRunId: string | null;
};

/**
 * True when a checkout is an agent claiming work for itself on its own run.
 *
 * This is the exact complement of `shouldWakeAssigneeOnCheckout`: when a wake
 * *is* sent, that wake carries the issue and the new run is scoped already, so
 * there is nothing to adopt.
 */
export function shouldAdoptRunSourceIssue(input: AdoptRunSourceIssueInput): boolean {
  if (input.actorType !== "agent") return false;
  if (!input.actorAgentId) return false;
  if (input.actorAgentId !== input.checkoutAgentId) return false;
  if (!input.checkoutRunId) return false;
  return true;
}

/**
 * Record `issueId` as the run's source issue, but only when it does not already
 * have one.
 *
 * Never overwrites: a run woken for issue A that later checks out issue B is
 * genuinely doing cross-issue work, and rewriting its source to B would let it
 * launder an unbounded number of cross-issue writes through repeated checkouts.
 * The `is null` guard in the WHERE clause is what makes that true concurrently
 * rather than only in the read-then-write window.
 *
 * Ownership is asserted in the same statement — a run only ever adopts an issue
 * for the agent and company it already belongs to.
 */
export async function adoptRunSourceIssue(
  db: Db,
  input: { runId: string; agentId: string; companyId: string; issueId: string },
): Promise<boolean> {
  const contextWithIssue = sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({
    issueId: input.issueId,
    source: "issue.checkout.self",
  })}::jsonb`;

  const updated = await db
    .update(heartbeatRuns)
    .set({ contextSnapshot: contextWithIssue, updatedAt: new Date() })
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.companyId, input.companyId),
        // Only an unscoped run adopts. Both spellings the reader accepts count
        // as already-scoped, or this would silently override `taskId`.
        or(
          isNull(heartbeatRuns.contextSnapshot),
          and(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is null`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' is null`,
          ),
        ),
      ),
    )
    .returning({ id: heartbeatRuns.id })
    .then((rows) => rows.length > 0);

  if (updated) {
    logger.info(
      { runId: input.runId, agentId: input.agentId, issueId: input.issueId },
      "run adopted its checked-out issue as source issue",
    );
  }
  return updated;
}
