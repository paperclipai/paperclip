import { inArray, or } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/**
 * Clears `issues.checkout_run_id` / `issues.execution_run_id` for the given
 * runs, so a following `delete from heartbeat_runs` has no referencing rows left
 * to act on.
 *
 * Both columns reference `heartbeat_runs.id` `on delete set null`, which makes a
 * run delete a two-table locker: Postgres runs
 * `update only issues set checkout_run_id = null where ... = checkout_run_id`
 * from inside the delete, taking `heartbeat_runs` before `issues`. The run
 * lifecycle takes the opposite order — `issuesSvc.checkout` locks the issue row
 * `for update` and only then locks the run row it points at. Two orders is a
 * deadlock cycle, and Postgres aborts whichever side it picks.
 *
 * Calling this first makes the deleting transaction lock `issues` before
 * `heartbeat_runs`, matching the lifecycle order, for every reference that
 * exists when it runs.
 *
 * It is not a total guarantee, and deliberately so. A reference committed
 * *after* this update — a checkout binding an issue to a run of the very agent
 * or company being deleted — is outside the set this locked, so the delete's FK
 * pass can still meet a holder of that issue row. Closing that would mean
 * locking every issue row in the company for the duration of a delete, which
 * costs more contention than the residual race is worth: it needs a checkout to
 * land on a doomed run mid-deletion. The cycle this removes is the one that
 * actually reproduces.
 */
export async function clearIssueRunReferences(
  tx: Pick<Db, "update">,
  runIds: string[],
): Promise<void> {
  if (runIds.length === 0) return;
  await tx
    .update(issues)
    .set({ checkoutRunId: null, executionRunId: null })
    .where(
      or(
        inArray(issues.checkoutRunId, runIds),
        inArray(issues.executionRunId, runIds),
      ),
    );
}
