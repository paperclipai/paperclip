import { and, eq } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";

export const STALE_CONTINUATION_ERROR_CODE = "continuation_task_ownership_changed";

const NATIVE_PROFILE_KEYS = ["nativeExecutionInput", "nativeWorkspaceSync", "remoteWorkspace",
  "nativeWorkspaceFinalizationOwner", "sessionCheckpoint"];

export async function isStaleContinuationCancelledBeforeDispatch(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" ||
      run.errorCode !== STALE_CONTINUATION_ERROR_CODE || run.executionStage !== "settled" || !run.finishedAt) return false;
  if (run.processPid || run.processGroupId || run.processStartedAt || run.nativeIssueId || run.nativeSessionId ||
      run.sessionIdAfter || run.runtimeModeResolvedAt) return false;
  if (run.resultJson?.workspaceRestoreFailure || run.resultJson?.workspaceRestoreRecovery ||
      hasRequiredWorkspaceRecovery(run.resultJson)) return false;
  if (NATIVE_PROFILE_KEYS.some(key => run.runnerProfileJson?.[key] != null)) return false;
  const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    executionStartedEventPredicate(),
  )).limit(1);
  return !started;
}
