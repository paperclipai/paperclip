import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { parseObject } from "../../adapters/utils.js";
import { assertRuntimeServiceLeaseDataAvailable, withRuntimeServiceLeaseLock } from "../runtime-services/retention.js";
import { sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import type { NativeControllerIdentity } from "./native-restart-recovery.js";
import { NativeRunnerOwnershipUnverifiedError } from "./native-runner-ownership.js";
import { nativeRunnerAllocationLeaseDigest, remoteRunnerRecoveryProcess, type RemoteRunnerRecoveryProcess, type RemoteRunnerRetentionAuthority } from "./remote-runner-recovery.js";
import { nativeSha256 } from "./canonical.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Digests of host-verified recovery inputs. No file contents or credentials
 * belong in the allocation's admission record. */
export interface NativeRemoteIdleReconnectionEvidence {
  sessionScopeSha256: string;
  checkpointSha256: string;
  hostAuthoritySha256: string;
}

export interface NativeRemoteIdleReconnection {
  version: 1;
  nonce: string;
  authorityNonce: string;
  state: "attaching" | "attached" | "failed";
  evidence: NativeRemoteIdleReconnectionEvidence;
  startedAt: string;
  settledAt?: string;
}

/** Host-owned retention evidence, not a liveness claim or a transferable tool
 * token. A future takeover must additionally verify completed finalization,
 * current allocation/configuration and fresh provider/kernel ownership. */
export interface NativeRemoteWarmRetention {
  version: 1;
  nonce: string;
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  runnerIdentity: {
    runId: string; runnerInstanceId: string; normalizedSessionId: string;
    environmentLeaseId: string; turnId: string; itemId: string;
  };
  sessionConfigDigest: string;
  executionDigest: string;
  /** Non-secret process settings needed to restore the warm supervisor. */
  supervisorEnvironment?: { networkAccess: boolean; githubAuthenticationMode?: string; credentialRunId?: string };
  allocationRunLeasesDigest: string;
  process: RemoteRunnerRecoveryProcess;
  controller: {
    leaseOwner: string; attempt: number; generation: number;
    bootId: string; pid: number; processStartedAt: string;
  };
  /** Idle ownership may move after the original controller exits. The run's
   * original controller and finalization history remain immutable. */
  controllerTakeover?: {
    version: 1;
    originNonce: string;
    generation: number;
    previousAuthoritySha256: string;
    claimedAt: string;
    authority: RemoteRunnerRetentionAuthority;
    /** Acquisition remains held until this controller restores supervision.
     * A failed/interrupted attempt is not permission to create another runner. */
    reconnection?: NativeRemoteIdleReconnection;
  };
  recordedAt: string;
  idleExpiresAt: string;
}

/** Capture the last active controller's exact process/session binding in the
 * same transaction that releases its run lease. Failed release rolls back the
 * evidence; expiry never proves that the process has stopped. */
export async function withNativeRemoteWarmRetention<T>(db: Db, input: {
  execution: NativeExecutionInput;
  environmentLeaseId: string;
  runnerInstanceId: string;
  runnerIdentity: Record<string, unknown> | null;
  sessionConfigDigest: string;
  leaseOwner: string;
  attempt: number;
  controllerGeneration: number;
  controller: NativeControllerIdentity;
  supervisorEnvironment?: NativeRemoteWarmRetention["supervisorEnvironment"];
}, release: (tx: Transaction, retention: NativeRemoteWarmRetention) => Promise<T>): Promise<T> {
  const unavailable = (): never => { throw new NativeRunnerOwnershipUnverifiedError("remote_runner_reattachment_unavailable"); };
  const binding = input.execution.binding;
  const policy = input.execution.session.lifecyclePolicy;
  const wire = input.runnerIdentity;
  const supervisor = input.supervisorEnvironment;
  if (supervisor && (typeof supervisor.networkAccess !== "boolean"
    || (supervisor.githubAuthenticationMode !== undefined && !["host", "managed"].includes(supervisor.githubAuthenticationMode))
    || (supervisor.credentialRunId !== undefined && supervisor.credentialRunId !== binding.runId))) return unavailable();
  if (policy.mode !== "warm" || !Number.isSafeInteger(policy.idleTimeoutMs) || policy.idleTimeoutMs <= 0
    || !/^sha256:[a-f0-9]{64}$/.test(input.sessionConfigDigest) || !input.execution.session.normalizedSessionId
    || !wire || wire.runId !== binding.runId || wire.runnerInstanceId !== input.runnerInstanceId
    || wire.normalizedSessionId !== input.execution.session.normalizedSessionId
    || ![wire.environmentLeaseId, wire.turnId, wire.itemId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))) return unavailable();
  const [initial] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, input.environmentLeaseId),
    eq(environmentLeases.companyId, binding.companyId), eq(environmentLeases.heartbeatRunId, binding.runId)));
  if (!initial) return unavailable();
  return withRuntimeServiceLeaseLock(db, initial, async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId))).for("update");
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId),
      eq(nativeRunFinalizations.companyId, binding.companyId))).for("update");
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, initial.id),
      eq(environmentLeases.companyId, binding.companyId))).for("update");
    if (!issue || !run || !owner || !lease || issue.executionRunId !== run.id || issue.assigneeAgentId !== binding.agentId
      || ["done", "cancelled"].includes(issue.status) || run.agentId !== binding.agentId || run.nativeIssueId !== binding.issueId
      || run.nativeSessionId !== input.execution.session.normalizedSessionId || run.runnerInstanceId !== input.runnerInstanceId
      || !sameRuntimeServiceConfiguration(parseObject(run.runnerProfileJson).nativeExecutionInput, input.execution)
      || owner.issueId !== binding.issueId || owner.leaseOwner !== input.leaseOwner || owner.attempt !== input.attempt
      || owner.controllerGeneration !== input.controllerGeneration
      || owner.controllerBootId !== input.controller.bootId || owner.controllerPid !== input.controller.pid
      || owner.controllerProcessStartedAt?.getTime() !== input.controller.processStartedAt.getTime()
      || !owner.leaseExpiresAt || owner.leaseExpiresAt.getTime() <= Date.now()) return unavailable();
    await assertRuntimeServiceLeaseDataAvailable(tx, lease);
    const process = remoteRunnerRecoveryProcess(lease, run);
    if (!process || lease.providerLeaseId !== initial.providerLeaseId || lease.environmentId !== initial.environmentId) return unavailable();
    const now = new Date();
    const retention: NativeRemoteWarmRetention = {
      version: 1, nonce: randomUUID(), companyId: binding.companyId, issueId: binding.issueId, agentId: binding.agentId, runId: binding.runId,
      normalizedSessionId: run.nativeSessionId!, runnerInstanceId: input.runnerInstanceId, sessionConfigDigest: input.sessionConfigDigest,
      executionDigest: nativeSha256(input.execution),
      ...(supervisor ? { supervisorEnvironment: { networkAccess: supervisor.networkAccess,
        ...(supervisor.githubAuthenticationMode ? { githubAuthenticationMode: supervisor.githubAuthenticationMode } : {}),
        ...(supervisor.credentialRunId ? { credentialRunId: supervisor.credentialRunId } : {}) } } : {}),
      allocationRunLeasesDigest: await nativeRunnerAllocationLeaseDigest(tx, lease),
      // The PRP lease identity survives warm attachment; it is distinct from
      // the per-run database lease. Copy only identity, never wire secrets.
      runnerIdentity: { runId: binding.runId, runnerInstanceId: input.runnerInstanceId, normalizedSessionId: run.nativeSessionId!,
        environmentLeaseId: wire.environmentLeaseId as string, turnId: wire.turnId as string, itemId: wire.itemId as string },
      process, controller: { leaseOwner: owner.leaseOwner!, attempt: owner.attempt, generation: owner.controllerGeneration,
        bootId: input.controller.bootId, pid: input.controller.pid, processStartedAt: input.controller.processStartedAt.toISOString() },
      recordedAt: now.toISOString(), idleExpiresAt: new Date(now.getTime() + policy.idleTimeoutMs).toISOString(),
    };
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeWarmRunnerRetention: retention }, updatedAt: now })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, binding.companyId)));
    return release(tx, retention);
  });
}
