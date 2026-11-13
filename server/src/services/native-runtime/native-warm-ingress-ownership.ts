import { and, eq, inArray } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

export type NativeWarmIngressIdentity = {
  provider: string;
  environmentId: string;
  providerLeaseId: string;
  leaseId: string;
  workspaceId: string;
  cwd: string;
};
export type NativeWarmIngressOwner = {
  companyId: string;
  agentId: string;
  issueId: string;
  runId: string;
  controllerBootId: string;
  controllerGeneration: number;
  ingress: NativeWarmIngressIdentity;
};
export type NativeWarmIngressClaim = NativeWarmIngressOwner & { leaseOwner: string };

export function nativeWarmIngressIdentity(execution: NativeExecutionInput, target?: AdapterExecutionTarget | null): NativeWarmIngressIdentity | undefined {
  if (target?.kind !== "remote" || target.transport !== "sandbox" || target.effectiveCapabilities?.runnerWebSocketIngress !== true
    || !target.providerKey || !target.environmentId || !target.leaseId || !target.sandboxLeaseAcquisition?.providerLeaseId
    || !("cwd" in execution.workspace) || !execution.workspace.cwd
    || execution.binding.executionWorkspaceId === execution.binding.runId) return undefined;
  return { provider: target.providerKey, environmentId: target.environmentId,
    providerLeaseId: target.sandboxLeaseAcquisition.providerLeaseId, leaseId: target.leaseId,
    workspaceId: execution.binding.executionWorkspaceId, cwd: execution.workspace.cwd };
}

export function nativeWarmIngressAllocation(identity: NativeWarmIngressIdentity): string {
  return JSON.stringify([identity.provider, identity.environmentId, identity.providerLeaseId]);
}

const busy = () => new Error("native_session_supervisor_busy");
export async function assertNativeWarmIngressRetirement(db: Db, current: NativeWarmIngressClaim, previous: NativeWarmIngressOwner): Promise<void> {
  if (current.companyId !== previous.companyId || current.agentId !== previous.agentId
    || current.ingress.workspaceId !== previous.ingress.workspaceId || current.ingress.cwd !== previous.ingress.cwd
    || nativeWarmIngressAllocation(current.ingress) !== nativeWarmIngressAllocation(previous.ingress)
    || current.runId === previous.runId) throw busy();
  await db.transaction(async tx => {
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, current.companyId), eq(executionWorkspaces.id, current.ingress.workspaceId),
    )).for("update");
    const authority = readRemoteWorkspaceAuthority(workspace?.metadata);
    if (!workspace || workspace.status !== "active" || authority?.writerRunId !== current.runId
      || authority.location?.environmentId !== current.ingress.environmentId
      || authority.location.providerLeaseId !== current.ingress.providerLeaseId
      || authority.location.leaseId !== current.ingress.leaseId || authority.location.remoteCwd !== current.ingress.cwd) throw busy();
    const runs = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, current.companyId),
      inArray(heartbeatRuns.id, [current.runId, previous.runId])));
    const incoming = runs.find(run => run.id === current.runId), prior = runs.find(run => run.id === previous.runId);
    const coordinators = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, current.companyId),
      inArray(nativeRunFinalizations.runId, [current.runId, previous.runId])));
    const incomingCoordinator = coordinators.find(row => row.runId === current.runId), priorCoordinator = coordinators.find(row => row.runId === previous.runId);
    const tasks = await tx.select().from(issues).where(and(eq(issues.companyId, current.companyId), inArray(issues.id, [current.issueId, previous.issueId])));
    const incomingTask = tasks.find(task => task.id === current.issueId), priorTask = tasks.find(task => task.id === previous.issueId);
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, current.companyId),
      inArray(environmentLeases.id, [current.ingress.leaseId, previous.ingress.leaseId])));
    const incomingLease = leases.find(lease => lease.id === current.ingress.leaseId), priorLease = leases.find(lease => lease.id === previous.ingress.leaseId);
    const now = Date.now();
    if (!incoming || incoming.runtimeMode !== "native" || incoming.status !== "running" || incoming.nativePhase !== "observed"
      || incoming.processPid !== null || incoming.processGroupId !== null || incoming.agentId !== current.agentId
      || incoming.nativeIssueId !== current.issueId || incoming.resultJson?.startupCancellation || incoming.resultJson?.nativeCancellation
      || incomingCoordinator?.issueId !== current.issueId || incomingCoordinator.phase !== "observed" || incomingCoordinator.resultId !== null || incomingCoordinator.leaseOwner !== current.leaseOwner
      || incomingCoordinator.controllerBootId !== current.controllerBootId || incomingCoordinator.controllerGeneration !== current.controllerGeneration
      || !incomingCoordinator.leaseExpiresAt || incomingCoordinator.leaseExpiresAt.getTime() <= now
      || incomingTask?.assigneeAgentId !== current.agentId || incomingTask.executionRunId !== current.runId
      || incomingTask.executionWorkspaceId !== current.ingress.workspaceId
      || !["in_progress", "in_review"].includes(incomingTask.status)
      || (incomingTask.checkoutRunId !== null && incomingTask.checkoutRunId !== current.runId)
      || !prior || prior.runtimeMode !== "native" || prior.status !== "succeeded" || !prior.finishedAt || prior.costAccountingPending
      || prior.agentId !== previous.agentId || prior.nativeIssueId !== previous.issueId || prior.nativePhase !== "committed"
      || priorCoordinator?.issueId !== previous.issueId || priorCoordinator.phase !== "committed" || !priorCoordinator.resultId
      || priorCoordinator.leaseOwner !== null || priorCoordinator.leaseExpiresAt !== null
      || priorCoordinator.controllerBootId !== previous.controllerBootId || priorCoordinator.controllerGeneration !== previous.controllerGeneration
      || !priorTask || priorTask.assigneeAgentId !== previous.agentId || priorTask.executionWorkspaceId !== previous.ingress.workspaceId
      || priorTask.executionRunId !== null || priorTask.checkoutRunId !== null) throw busy();
    const leaseMatches = (lease: typeof environmentLeases.$inferSelect | undefined, owner: NativeWarmIngressOwner) => lease
      && lease.heartbeatRunId === owner.runId && lease.issueId === owner.issueId
      && lease.environmentId === owner.ingress.environmentId && lease.provider === owner.ingress.provider
      && lease.providerLeaseId === owner.ingress.providerLeaseId && lease.executionWorkspaceId === owner.ingress.workspaceId;
    if (!leaseMatches(incomingLease, current) || incomingLease!.status !== "active"
      || (incomingLease!.expiresAt !== null && incomingLease!.expiresAt.getTime() <= now)
      || !leaseMatches(priorLease, previous) || !["released", "expired"].includes(priorLease!.status)
      || priorLease!.cleanupStatus !== "success") throw busy();
    const otherLeases = await tx.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, current.companyId), eq(environmentLeases.environmentId, current.ingress.environmentId),
      eq(environmentLeases.provider, current.ingress.provider), eq(environmentLeases.providerLeaseId, current.ingress.providerLeaseId),
      eq(environmentLeases.status, "active"),
    ));
    if (otherLeases.some(lease => lease.runId !== current.runId)) throw busy();
  });
}
