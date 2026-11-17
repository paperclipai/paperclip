import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  completeTerminatedRemoteNativeSessionCleanupForTask,
  nativeSessionCleanupBlock,
  nativeSessionCleanupRemoteScopes,
} from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { terminatedRemoteCleanupScope } from "../remote-execution-termination.js";

async function retireTerminatedRemoteCleanup(db: Db, input: { companyId: string; issueId: string }) {
  for (const remoteCleanupScope of nativeSessionCleanupRemoteScopes(input)) {
    const lease = await terminatedRemoteCleanupScope(db, input.companyId, remoteCleanupScope).catch(() => null);
    if (!lease) continue;
    const retired = completeTerminatedRemoteNativeSessionCleanupForTask({ ...input, remoteCleanupScope });
    if (retired === 0) continue;
    logger.warn({ companyId: input.companyId, issueId: input.issueId, leaseId: lease.id, runId: lease.heartbeatRunId,
      provider: lease.provider, providerLeaseId: lease.providerLeaseId, retired },
    "native session cleanup retired because its sandbox is confirmed terminated");
    if (!lease.heartbeatRunId) continue;
    const [run] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId)))
      .limit(1).catch(() => []);
    if (!run) continue;
    await appendHeartbeatRunEvent(db, {
      companyId: input.companyId, runId: lease.heartbeatRunId, agentId: run.agentId,
      eventType: "native.session_cleanup_gate_retired", stream: "system", level: "info",
      message: "The task's previous sandbox is confirmed terminated, so its session cleanup gate was retired.",
      payload: { leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId,
        termination: lease.metadata?.remoteExecutionTermination ?? null, retired },
    }).catch(() => undefined);
  }
}

export async function nativeCleanupHoldsAdmission(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<"pending" | "operator_required" | null> {
  let block = nativeSessionCleanupBlock(input);
  if (block === null) return null;
  await retireTerminatedRemoteCleanup(db, input);
  block = nativeSessionCleanupBlock(input);
  if (block === "operator_required") {
    const { retireStoppedSessionCleanupGates } = await import("./native-session-executor.js");
    await retireStoppedSessionCleanupGates(db, input).catch(() => false);
    block = nativeSessionCleanupBlock(input);
  }
  return block;
}
