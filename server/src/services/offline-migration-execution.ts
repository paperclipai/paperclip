import { and, eq, isNotNull, not, or } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";

/** Only for offline maintenance after every application deployment has stopped.
 * Never-started queued turns are durable admission intent, not filesystem
 * writers. Keep their rows untouched so the replacement can claim them normally.
 * A requeued execution or one with retained execution ownership still blocks. */
export function offlineMigrationExecutionWhere() {
  return or(
    eq(heartbeatRuns.status, "running"),
    and(eq(heartbeatRuns.status, "queued"), or(
      not(noRetainedExecutionPredicate()!),
      isNotNull(heartbeatRuns.runnerInstanceId),
      isNotNull(heartbeatRuns.nativePhase),
    )),
  );
}
