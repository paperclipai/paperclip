import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunWatchdogDecisions } from "@paperclipai/db";

export type WatchdogDecisionState = {
  dismissedFalsePositive: boolean;
  quietUntilDecision: {
    decision: "snooze" | "continue";
    snoozedUntil: Date;
  } | null;
};

/**
 * Resolves the durable watchdog decision state for one heartbeat run: whether
 * the board ever dismissed the silence signal as a false positive, and whether
 * a snooze/continue decision currently shields the run (snoozedUntil in the
 * future). Lives in its own leaf module so both the watchdog adapter and the
 * issue binding guards read one shared query instead of duplicating the
 * decision semantics. Accepts any read handle (a full `Db` or an open
 * transaction) so callers inside a transaction reuse their connection instead
 * of re-entering the outer pool.
 */
export async function findLatestWatchdogDecisionState(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  runId: string,
  now: Date,
): Promise<WatchdogDecisionState> {
  const [quietUntilRows, dismissedRows] = await Promise.all([
    dbOrTx
      .select({
        decision: heartbeatRunWatchdogDecisions.decision,
        snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil,
      })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1),
    dbOrTx
      .select({ id: heartbeatRunWatchdogDecisions.id })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
        ),
      )
      .limit(1),
  ]);
  const quietUntilRow = quietUntilRows[0];
  return {
    dismissedFalsePositive: dismissedRows.length > 0,
    quietUntilDecision: quietUntilRow && quietUntilRow.snoozedUntil
      ? {
          decision: quietUntilRow.decision as "snooze" | "continue",
          snoozedUntil: quietUntilRow.snoozedUntil,
        }
      : null,
  };
}
