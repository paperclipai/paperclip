import { and, eq, or } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt, remoteExecutionHasStopped } from "./remote-execution-termination.js";

/** The first check that refused a retained plugin task resume, named in the error. */
export type PluginTaskResumeRefusal =
  | "next_lease_missing"
  | "predecessor_candidate_missing"
  | "predecessor_candidate_ambiguous"
  | "predecessor_task_missing"
  | "identity_mismatch"
  | "provider_mismatch"
  | "next_task_missing"
  | "same_provider_task"
  | "predecessor_run_active"
  | "scope_mismatch"
  | "next_lease_inactive"
  | "next_run_not_running"
  | "predecessor_not_stopped"
  | "checkpoint_status_unconfirmed"
  | "resume_task_mismatch";

/** Keeps the original message as a prefix so existing matchers still apply. */
export function pluginTaskResumeRefused(reason: PluginTaskResumeRefusal) {
  return new Error(`Plugin Runner retained session is not authorized (reason: ${reason})`);
}

type ResumeRow = { lease: typeof environmentLeases.$inferSelect; run: typeof heartbeatRuns.$inferSelect };
type PriorIdentity = { runnerInstanceId: string; environmentLeaseId: string; runId: string; normalizedSessionId: string };

const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"];

/** Cheap, synchronous checks in evaluation order; the stop proof is read only after these pass. */
function resumeRefusal(priorIdentity: PriorIdentity, next: ResumeRow | undefined, candidates: ResumeRow[]): PluginTaskResumeRefusal | null {
  if (!next) return "next_lease_missing";
  if (candidates.length === 0) return "predecessor_candidate_missing";
  if (candidates.length > 1) return "predecessor_candidate_ambiguous";
  const old = candidates[0]!;
  const identity = old.lease.metadata?.runnerTaskIdentity as Record<string, unknown> | undefined;
  if (!old.lease.providerLeaseId) return "predecessor_task_missing";
  if (!identity || identity.runnerId !== priorIdentity.runnerInstanceId || identity.leaseId !== priorIdentity.environmentLeaseId ||
      identity.sessionId !== priorIdentity.normalizedSessionId || identity.runId !== priorIdentity.runId) return "identity_mismatch";
  if (old.lease.metadata?.driver !== "plugin" || next.lease.metadata?.driver !== "plugin") return "provider_mismatch";
  if (!next.lease.providerLeaseId) return "next_task_missing";
  if (next.lease.providerLeaseId === old.lease.providerLeaseId) return "same_provider_task";
  if (old.run.id !== next.run.id && !TERMINAL_RUN_STATUSES.includes(old.run.status)) return "predecessor_run_active";
  if (old.run.agentId !== next.run.agentId || old.lease.issueId !== next.lease.issueId ||
      old.lease.executionWorkspaceId !== next.lease.executionWorkspaceId ||
      !old.lease.environmentId || old.lease.environmentId !== next.lease.environmentId) return "scope_mismatch";
  if (!next.lease.provider?.startsWith("plugin:") || old.lease.provider !== next.lease.provider ||
      old.lease.metadata?.pluginId !== next.lease.metadata?.pluginId ||
      old.lease.metadata?.driverKey !== next.lease.metadata?.driverKey) return "provider_mismatch";
  if (next.lease.status !== "active" || next.lease.releasedAt ||
      (next.lease.expiresAt && next.lease.expiresAt.getTime() <= Date.now())) return "next_lease_inactive";
  if (next.run.status !== "running") return "next_run_not_running";
  return null;
}

/** A saved provider task can resume only within the same authorized agent workspace. */
export async function resolvePluginTaskResume(db: Db, input: {
  companyId: string; leaseId: string;
  priorIdentity: PriorIdentity;
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
      row.lease.metadata?.portableTaskSuccessor === undefined &&
      (!Object.hasOwn(row.lease.metadata ?? {}, "runnerTaskSourceConsumer") ||
        consumer?.leaseId === input.leaseId && consumer.runId === next?.run.id && consumer.resumeFrom === row.lease.providerLeaseId) &&
      (input.inspectCheckpoint || row.lease.metadata?.runnerTaskSessionRetained === true) &&
      identity?.runnerId === input.priorIdentity.runnerInstanceId && identity.leaseId === input.priorIdentity.environmentLeaseId &&
      identity.sessionId === input.priorIdentity.normalizedSessionId && identity.runId === input.priorIdentity.runId &&
      !rows.some(successor => successor.lease.id !== input.leaseId &&
        successor.lease.metadata?.runnerTaskResumeFrom === row.lease.providerLeaseId);
  });
  const refusal = resumeRefusal(input.priorIdentity, next, candidates);
  if (refusal) throw pluginTaskResumeRefused(refusal);
  const old = candidates[0]!;
  const stopped = old.run.id === next!.run.id
    ? rows.filter(row => row.lease.id !== next!.lease.id).every(row => hasRemoteTerminationReceipt(row.lease))
    : await remoteExecutionHasStopped(db, input.companyId, old.run.id);
  if (!stopped) throw pluginTaskResumeRefused("predecessor_not_stopped");
  return old.lease.providerLeaseId!;
}
