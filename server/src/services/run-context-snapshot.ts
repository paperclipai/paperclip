import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/**
 * Fields the heartbeat completion path owns once an adapter returns runtime
 * services. They are the only snapshot fields that writer may replace.
 */
export type RunRuntimeServicesSnapshot = {
  paperclipRuntimeServices: unknown;
  paperclipRuntimePrimaryUrl: string | null;
};

/**
 * Merge the completion writer's runtime-service fields into a run's persisted
 * `contextSnapshot` without replacing the rest of the snapshot.
 *
 * An execution reads the run row's `contextSnapshot` once, at start, and keeps
 * it in memory as `context`. The checkout route can anchor a taskless run to
 * the issue it claims by writing `issueId` into the same `contextSnapshot`
 * after that read. Writing the stale in-memory `context` back wholesale would
 * erase the anchor: later writes on the checked-out issue would fail with
 * `cross_issue_influence_run_context_required` again, and a second checkout
 * would rebind the run to a different source despite the bind-once contract.
 *
 * Merging only the owned fields keeps every field this writer does not own —
 * including the checkout anchor — exactly as the database has it.
 */
export async function mergeRunRuntimeServicesIntoSnapshot(
  db: Db,
  input: {
    runId: string;
    runtimeServices: readonly unknown[];
    primaryUrl?: string | null;
  },
): Promise<void> {
  const fields: RunRuntimeServicesSnapshot = {
    paperclipRuntimeServices: input.runtimeServices,
    paperclipRuntimePrimaryUrl: input.primaryUrl ?? null,
  };
  await db
    .update(heartbeatRuns)
    .set({
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(heartbeatRuns.id, input.runId));
}
