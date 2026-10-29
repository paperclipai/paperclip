import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { classifyWorkspaceRestoreFailure } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { logger } from "../../middleware/logger.js";

/** An unsafe export cannot invalidate an already accepted agent result. */
export async function restoreNativeWorkspaceBestEffort<T>(input: {
  db: Db;
  runId: string;
  restore: () => Promise<T>;
  assertOwnership?: () => Promise<void>;
}): Promise<T | undefined> {
  try {
    return await input.restore();
  } catch (error) {
    // Losing finalization ownership must never open the workspace barrier.
    await input.assertOwnership?.();
    if (classifyWorkspaceRestoreFailure(error) !== "restore_unsafe_archive") throw error;
    // The provider salvages confined archive entries when possible. A source
    // that itself escapes the workspace cannot be exported at all. Both cases
    // intentionally allow lost remote files: unsafe persistence must not fail
    // an accepted task result. This diagnostic stays in run logs, never the task.
    try {
      const [run] = await input.db.select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).limit(1);
      if (run) await appendHeartbeatRunEvent(input.db, {
        ...run,
        runId: input.runId,
        eventType: "workspace_export_omitted",
        stream: "system",
        level: "info",
        message: "Unsafe workspace export omitted; continuing with the accepted result.",
        payload: { reason: "restore_unsafe_archive" },
      });
    } catch {
      logger.info({ runId: input.runId }, "Unsafe workspace export omitted; run diagnostic could not be persisted");
    }
    return undefined;
  }
}
