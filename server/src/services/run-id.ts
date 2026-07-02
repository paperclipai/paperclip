import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbExecutor = Db | DbTransaction;

/**
 * Resolve a candidate `createdByRunId` against `heartbeat_runs`.
 *
 * Every `created_by_run_id` column carries an FK to `heartbeat_runs`, so a
 * stale, foreign, or malformed run-id would otherwise surface as a raw 500 at
 * insert time — an FK violation, or a `22P02` invalid-uuid syntax error for
 * non-UUID input. We guard non-UUID input with `isUuidLike` and demote anything
 * we cannot resolve to `NULL`, preserving the row (and its audit trail) over
 * hard rejection while logging a warning so the dropped linkage stays
 * observable. Valid, existing run-ids are returned unchanged.
 *
 * Shared by `issues.addComment`, `documentAnnotations` comment inserts, and
 * `routines.appendRoutineRevision` (TON-2665 / TON-2666).
 */
export async function resolveCreatedByRunId(
  executor: DbExecutor,
  runId: string | null | undefined,
  context: Record<string, unknown> = {},
): Promise<string | null> {
  const candidate = runId ?? null;
  if (!candidate) return null;

  const runExists = isUuidLike(candidate)
    ? await executor
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, candidate))
        .then((rows: Array<{ id: string }>) => rows[0] ?? null)
    : null;

  if (!runExists) {
    logger.warn(
      { ...context, runId: candidate },
      "unknown or malformed createdByRunId; demoting to NULL to avoid FK 500",
    );
    return null;
  }

  return candidate;
}
