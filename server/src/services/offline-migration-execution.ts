import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations } from "@paperclipai/db";

/** Only for offline maintenance after every application deployment has stopped.
 * Never-started queued turns are durable admission intent, not filesystem
 * writers. Keep their rows untouched so the replacement can claim them normally.
 * A requeued execution or one with retained execution ownership still blocks. */
export function offlineMigrationExecutionWhere() {
  return or(
    eq(heartbeatRuns.status, "running"),
    and(eq(heartbeatRuns.status, "queued"), or(
      isNotNull(heartbeatRuns.startedAt),
      isNotNull(heartbeatRuns.processPid),
      isNotNull(heartbeatRuns.processStartedAt),
      isNotNull(heartbeatRuns.runnerInstanceId),
      isNotNull(heartbeatRuns.nativeSessionId),
      isNotNull(heartbeatRuns.nativePhase),
      isNotNull(heartbeatRuns.controllerLeaseExpiresAt),
      sql`exists (select 1 from ${nativeRunFinalizations} where ${and(
        eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
        eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      )})`,
      sql`exists (select 1 from ${environmentLeases} where ${and(
        eq(environmentLeases.companyId, heartbeatRuns.companyId),
        eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
      )})`,
    )),
  );
}
