import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { legacyControllerBootId } from "../legacy-controller-lease.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";

export function createRunLogWriterAuthority(
  db: Db,
  admitted: typeof heartbeatRuns.$inferSelect,
  nativeLeaseOwner?: string,
) {
  return async () => {
    const [run] = await db
      .select({
        id: heartbeatRuns.id,
        runtimeMode: heartbeatRuns.runtimeMode,
        controllerBootId: heartbeatRuns.controllerBootId,
        leaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, admitted.id),
          eq(heartbeatRuns.companyId, admitted.companyId),
          eq(heartbeatRuns.agentId, admitted.agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    if (!run) throw new Error("run_log_writer_authority_lost");
    if (run.runtimeMode !== "native") {
      if (
        run.controllerBootId !== legacyControllerBootId ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= new Date()
      )
        throw new Error("run_log_writer_authority_lost");
      return;
    }
    const [owner] = await db
      .select({
        leaseOwner: nativeRunFinalizations.leaseOwner,
        bootId: nativeRunFinalizations.controllerBootId,
        expiresAt: nativeRunFinalizations.leaseExpiresAt,
      })
      .from(nativeRunFinalizations)
      .where(
        and(
          eq(nativeRunFinalizations.runId, admitted.id),
          eq(nativeRunFinalizations.companyId, admitted.companyId),
        ),
      );

    if (!owner && !run.logStore && !run.logRef && !admitted.logStore && !admitted.logRef) return;
    const identity = await currentNativeControllerIdentity();
    if (
      !owner ||
      owner.bootId !== identity.bootId ||
      !owner.expiresAt ||
      owner.expiresAt <= new Date() ||
      (nativeLeaseOwner !== undefined && owner.leaseOwner !== nativeLeaseOwner)
    )
      throw new Error("run_log_writer_authority_lost");
  };
}
