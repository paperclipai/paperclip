import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasProviderDispatchEvidence, leaseRetainsResources, readRunEnvironmentLeases } from "./run-dispatch-evidence.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;

export async function isCancelledBeforeProviderDispatch(
  db: Db, run: Run, coordinator: Coordinator | undefined,
): Promise<boolean> {
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || !run.finishedAt) return false;
  if (run.processPid || run.processGroupId || run.processStartedAt) return false;
  if (run.nativeSessionId || run.sessionIdAfter) return false;
  if (coordinator) return false;
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
  if ((await readRunEnvironmentLeases(db, run)).some(leaseRetainsResources)) return false;
  return !await hasProviderDispatchEvidence(db, run);
}
