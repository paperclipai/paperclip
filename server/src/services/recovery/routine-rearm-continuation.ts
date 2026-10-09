import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routines, routineTriggers } from "@paperclipai/db";

const ROUTINE_EXECUTION_ORIGIN_KIND = "routine_execution";

/**
 * A scheduled routine keeps re-arming its work: every fire creates the next
 * `routine_execution` issue. When the routine has an enabled schedule trigger,
 * that schedule is the durable continuation for the one-shot execution issue.
 * A successful poll run that leaves its execution issue without a disposition
 * is then a *re-armed* poll — a valid terminal state — not a missing
 * disposition.
 *
 * The schedule check matters. An active routine can also be manual-only (an
 * `api` trigger, a disabled schedule, or no trigger at all). Without a next
 * fire there is no automatic continuation, so treating the execution issue as
 * re-armed would leave it open with no disposition and no wake (review finding
 * on this change). In that case callers must fall through to normal recovery.
 * The trigger must be enabled, not archived, and fully set up (not
 * `setupPending`) — an archived or setup-pending trigger keeps its cron but
 * never fires.
 *
 * Without this check the disposition watchdog hands a completed poll to the
 * correction path, which parks the issue `blocked` and escalates it to the
 * board (COR-3258): the run succeeded, but nothing ever closed the one-shot
 * issue the routine created.
 *
 * Returns the owning routine id when `issue` is an execution issue of an active
 * routine that still has an enabled schedule trigger, else null.
 */
export async function activeScheduledRoutineIdForExecutionIssue(
  db: Db,
  issue: {
    companyId: string;
    originKind?: string | null;
    originId?: string | null;
  },
): Promise<string | null> {
  if (issue.originKind !== ROUTINE_EXECUTION_ORIGIN_KIND) return null;
  const routineId = issue.originId?.trim();
  if (!routineId) return null;

  const row = await db
    .select({ id: routines.id })
    .from(routines)
    .innerJoin(
      routineTriggers,
      and(
        eq(routineTriggers.routineId, routines.id),
        eq(routineTriggers.companyId, routines.companyId),
        eq(routineTriggers.enabled, true),
        eq(routineTriggers.archived, false),
        eq(routineTriggers.setupPending, false),
        isNotNull(routineTriggers.cronExpression),
      ),
    )
    .where(
      and(
        eq(routines.companyId, issue.companyId),
        eq(routines.id, routineId),
        eq(routines.status, "active"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.id ?? null;
}
