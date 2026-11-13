import { and, eq, or } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt, remoteExecutionHasStopped } from "./remote-execution-termination.js";

/** A saved provider task can resume only within the same authorized agent workspace. */
export async function resolvePluginTaskResume(db: Db, input: {
  companyId: string; leaseId: string;
  priorIdentity: { runnerInstanceId: string; environmentLeaseId: string; runId: string; normalizedSessionId: string };
  /** Read-only discovery; launching still requires an attested retained checkpoint. */
  inspectCheckpoint?: boolean;
}): Promise<string> {
  const rows = await db.select({ lease: environmentLeases, run: heartbeatRuns }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, input.companyId)))
    .where(and(eq(environmentLeases.companyId, input.companyId),
      or(eq(environmentLeases.id, input.leaseId), eq(heartbeatRuns.id, input.priorIdentity.runId))));
  const next = rows.find(row => row.lease.id === input.leaseId);
  // A retained PRP lease is logical; later provider tasks have different physical lease IDs.
  const candidates = rows.filter(row => {
    const identity = row.lease.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined;
    const consumer = row.lease.metadata?.runnerTaskSourceConsumer as { leaseId?: unknown; runId?: unknown; resumeFrom?: unknown } | null | undefined;
    return row.lease.id !== input.leaseId && row.run.id === input.priorIdentity.runId &&
      (!Object.hasOwn(row.lease.metadata ?? {}, "runnerTaskSourceConsumer") ||
        consumer?.leaseId === input.leaseId && consumer.runId === next?.run.id && consumer.resumeFrom === row.lease.providerLeaseId) &&
      (input.inspectCheckpoint || row.lease.metadata?.runnerTaskSessionRetained === true) &&
      identity?.runnerId === input.priorIdentity.runnerInstanceId && identity.leaseId === input.priorIdentity.environmentLeaseId &&
      identity.sessionId === input.priorIdentity.normalizedSessionId && identity.runId === input.priorIdentity.runId &&
      !rows.some(successor => successor.lease.id !== input.leaseId &&
        successor.lease.metadata?.runnerTaskResumeFrom === row.lease.providerLeaseId);
  });
  const old = candidates.length === 1 ? candidates[0] : undefined;
  const identity = old?.lease.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined;
  if (!old || !next || !old.lease.providerLeaseId || !identity ||
      identity.runnerId !== input.priorIdentity.runnerInstanceId || identity.leaseId !== input.priorIdentity.environmentLeaseId ||
      identity.sessionId !== input.priorIdentity.normalizedSessionId || identity.runId !== input.priorIdentity.runId ||
      old.lease.metadata?.driver !== "plugin" || next.lease.metadata?.driver !== "plugin" ||
      !next.lease.providerLeaseId || next.lease.providerLeaseId === old.lease.providerLeaseId ||
      (old.run.id !== next.run.id && !["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(old.run.status)) ||
      old.run.agentId !== next.run.agentId || old.lease.issueId !== next.lease.issueId ||
      old.lease.executionWorkspaceId !== next.lease.executionWorkspaceId ||
      !old.lease.environmentId || old.lease.environmentId !== next.lease.environmentId ||
      !next.lease.provider?.startsWith("plugin:") || old.lease.provider !== next.lease.provider ||
      old.lease.metadata?.pluginId !== next.lease.metadata?.pluginId || old.lease.metadata?.driverKey !== next.lease.metadata?.driverKey ||
      next.lease.status !== "active" || next.lease.releasedAt || next.run.status !== "running" ||
      (next.lease.expiresAt && next.lease.expiresAt.getTime() <= Date.now()) ||
      !(old.run.id === next.run.id
        ? rows.filter(row => row.lease.id !== next.lease.id).every(row => hasRemoteTerminationReceipt(row.lease))
        : await remoteExecutionHasStopped(db, input.companyId, old.run.id))) {
    throw new Error("Plugin Runner retained session is not authorized");
  }
  return old.lease.providerLeaseId;
}
