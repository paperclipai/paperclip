import { heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { and, eq, exists } from "drizzle-orm";

/**
 * An accepted result transfers recovery to the workspace finalizer. A dead
 * provider PID cannot authorize discarding its unfinished workspace suffix,
 * including the interval before physical copyback acquires its owner receipt.
 * The heartbeat's display phase and arbitrary profile JSON are not evidence.
 */
export function pendingNativeWorkspaceFinalizationCondition(db: Db) {
  return and(
    eq(heartbeatRuns.runtimeMode, "native"),
    exists(db.select({ runId: nativeRunFinalizations.runId })
      .from(nativeRunFinalizations)
      .innerJoin(nativeRunResults, and(
        eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId),
        eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId),
        eq(nativeRunResults.schemaStatus, "accepted"),
      ))
      .where(and(
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.issueId, heartbeatRuns.nativeIssueId),
        eq(nativeRunFinalizations.phase, "workspace_finalizing"),
      ))),
  )!;
}
