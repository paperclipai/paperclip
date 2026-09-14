import { and, eq, isNotNull } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { RemoteProcessIdentity } from "@paperclipai/shared/remote-process-identity";
import type { RemoteProcessControlOperation, RemoteProcessControlState } from "@paperclipai/shared/remote-process-control";
import type { PluginEnvironmentRunProcessControlParams, PluginEnvironmentRunProcessControlResult, PluginEnvironmentRunnerRecoveryParams, PluginEnvironmentRunnerRecoveryResult, PluginEnvironmentRunnerRecoveryExecuteParams, PluginEnvironmentRunnerRecoveryExecuteResult } from "@paperclipai/plugin-sdk";
import { remoteRuntimeServiceProcessOwnerSchema } from "../runtime-services/remote-process-handoff.js";
import { runtimeServiceRunScopeSchema, sameRuntimeServiceConfiguration } from "../runtime-services/run-attachment.js";
import { assertRuntimeServiceLeaseDataAvailable, withRuntimeServiceLeaseLock } from "../runtime-services/retention.js";
import { nativeSha256 } from "./canonical.js";
import { verifyNativeHarnessBackupStamp, type NativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { readProcessStartedAt } from "../hot-restart.js";
import { logActivity } from "../activity-log.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import type { NativeRemoteIdleReconnection, NativeRemoteIdleReconnectionEvidence, NativeRemoteWarmRetention } from "./native-remote-warm-retention.js";

type Lease = typeof environmentLeases.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
export interface RemoteRunnerRecoveryProcess {
  processLocation: "remote";
  pid: number;
  processGroupId: null;
  startedAt: string;
  remoteProcessIdentity: RemoteProcessIdentity;
  environmentLeaseId: string;
  environmentId: string;
  providerLeaseId: string;
  workspaceRoot: string;
  configurationDigest: string;
  workspaceConnection: { scopeId: string; fingerprint: string };
}
/** Host-only controller authority; never part of a provider RPC. */
export type RemoteRunnerRecoveryController = { leaseOwner: string; controllerGeneration: number };
/** The currently admitted controller's idle authority. Reading this record
 * grants neither takeover nor ingress, ordinary commands or workspace writes. */
export type RemoteRunnerRetentionAuthority = { nonce: string; bootId: string; pid: number; processStartedAt: string };
export type RemoteRunProcessControlInput = {
  companyId: string; runId: string; environmentLeaseId: string;
  expectedController?: RemoteRunnerRecoveryController;
  expectedRetention?: RemoteRunnerRetentionAuthority;
  expectedIdleReconnectionNonce?: string;
} & ({ operation: { action: "inspect" }; expectedOwner?: RemoteProcessIdentity }
  | { operation: Exclude<RemoteProcessControlOperation, { action: "inspect" }>; expectedOwner: RemoteProcessIdentity });
export type RemoteRunProcessControlResult = { state: RemoteProcessControlState; process?: RemoteRunnerRecoveryProcess };

export function remoteRunnerRecoveryProcess(lease: Lease, run: Run): RemoteRunnerRecoveryProcess | null {
  if (lease.status !== "active" || lease.releasedAt || (lease.expiresAt && lease.expiresAt.getTime() <= Date.now())
    || !["running", "failed"].includes(run.status)) return null;
  return remoteRunnerProcessBinding(lease, run);
}

/** Identity reconstruction only; callers separately prove active or idle
 * authority. A retained lease must never enter the active recovery path. */
function remoteRunnerProcessBinding(lease: Lease, run: Run): RemoteRunnerRecoveryProcess | null {
  const owner = remoteRuntimeServiceProcessOwnerSchema.safeParse(lease.metadata?.runtimeServiceProcessOwner);
  const scope = runtimeServiceRunScopeSchema.safeParse(lease.metadata?.runtimeServiceRunScope);
  const boundary = lease.metadata?.runtimeServiceBoundary as { provider?: unknown; workspaceRoot?: unknown } | undefined;
  if (!owner.success || !scope.success || lease.companyId !== run.companyId || lease.heartbeatRunId !== run.id
    || lease.provider !== "daytona" || !lease.providerLeaseId || !lease.environmentId || run.runtimeMode !== "native"
    || run.processLocation === "local" || run.processGroupId !== null || !run.processStartedAt
    || run.processPid !== owner.data.process.pid || owner.data.process.processGroupId !== owner.data.process.pid
    || owner.data.runId !== run.id || owner.data.environmentLeaseId !== lease.id || owner.data.providerLeaseId !== lease.providerLeaseId
    || owner.data.workspaceRoot === "/" || boundary?.provider !== "daytona" || boundary.workspaceRoot !== owner.data.workspaceRoot
    || scope.data.companyId !== run.companyId || scope.data.environmentId !== lease.environmentId || scope.data.pluginId !== lease.metadata?.pluginId) return null;
  return { processLocation: "remote", pid: owner.data.process.pid, processGroupId: null, startedAt: run.processStartedAt.toISOString(),
    remoteProcessIdentity: owner.data.process, environmentLeaseId: lease.id, environmentId: lease.environmentId,
    providerLeaseId: lease.providerLeaseId, workspaceRoot: owner.data.workspaceRoot,
    configurationDigest: scope.data.configurationDigest, workspaceConnection: scope.data.connection };
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function validReconnectionEvidence(value: unknown): value is NativeRemoteIdleReconnectionEvidence {
  const evidence = object(value);
  return Object.keys(evidence).length === 3 && ["sessionScopeSha256", "checkpointSha256", "hostAuthoritySha256"]
    .every(key => typeof evidence[key] === "string" && /^[a-f0-9]{64}$/.test(evidence[key]));
}

/** Validate the nested admission independently of provider-supplied data. */
function idleReconnection(value: unknown): NativeRemoteIdleReconnection | null {
  const takeover = object(object(value).controllerTakeover), marker = object(takeover.reconnection);
  if (marker.version !== 1 || typeof marker.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(marker.nonce)
    || marker.authorityNonce !== object(takeover.authority).nonce || marker.nonce === marker.authorityNonce
    || !["attaching", "attached", "failed"].includes(String(marker.state)) || !validReconnectionEvidence(marker.evidence)
    || typeof marker.startedAt !== "string" || !Number.isFinite(Date.parse(marker.startedAt))
    || (marker.state === "attaching" ? marker.settledAt !== undefined
      : typeof marker.settledAt !== "string" || !Number.isFinite(Date.parse(marker.settledAt)))) return null;
  return marker as unknown as NativeRemoteIdleReconnection;
}

/** Select a host-written idle epoch. A malformed takeover never falls back to
 * the old authority. Provider/run/retention verification remains mandatory. */
export function nativeRemoteRetentionAuthority(value: unknown): RemoteRunnerRetentionAuthority | null {
  const retention = object(value), controller = object(retention.controller);
  const validNonce = (nonce: unknown) => typeof nonce === "string" && /^[a-f0-9-]{36}$/.test(nonce);
  const validAuthority = (candidate: Record<string, unknown>) => validNonce(candidate.nonce)
    && typeof candidate.bootId === "string" && Boolean(candidate.bootId) && candidate.bootId.length <= 512
    && Number.isSafeInteger(candidate.pid) && Number(candidate.pid) > 0
    && typeof candidate.processStartedAt === "string" && Number.isFinite(Date.parse(candidate.processStartedAt));
  if (!validNonce(retention.nonce)) return null;
  let candidate: Record<string, unknown> = { nonce: retention.nonce, bootId: controller.bootId,
    pid: controller.pid, processStartedAt: controller.processStartedAt };
  if (!validAuthority(candidate)) return null;
  if (retention.controllerTakeover !== undefined) {
    const takeover = object(retention.controllerTakeover);
    if (takeover.version !== 1 || takeover.originNonce !== retention.nonce || !Number.isSafeInteger(takeover.generation)
      || Number(takeover.generation) < 1 || typeof takeover.previousAuthoritySha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(takeover.previousAuthoritySha256)
      || typeof takeover.claimedAt !== "string" || !Number.isFinite(Date.parse(takeover.claimedAt))) return null;
    candidate = object(takeover.authority);
    if (candidate.nonce === retention.nonce) return null;
    if (takeover.reconnection !== undefined && !idleReconnection(retention)) return null;
  }
  if (!validAuthority(candidate)) return null;
  return { nonce: candidate.nonce as string, bootId: candidate.bootId as string, pid: Number(candidate.pid), processStartedAt: candidate.processStartedAt as string };
}

/** A constant-size watermark of allocation membership, without relying on
 * host clocks to order leases. Called under the physical allocation lock. */
export async function nativeRunnerAllocationLeaseDigest(db: Pick<Db, "select">, lease: Pick<Lease, "companyId" | "provider" | "providerLeaseId">) {
  if (!lease.provider || !lease.providerLeaseId) throw new Error("native_remote_runner_allocation_unavailable");
  const rows = await db.select({ id: environmentLeases.id, runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.provider, lease.provider),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId), isNotNull(environmentLeases.heartbeatRunId),
  ));
  return nativeSha256(rows.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function retainedRunnerBinding(lease: Lease, run: Run, coordinator: typeof nativeRunFinalizations.$inferSelect | undefined,
  expected: RemoteRunnerRetentionAuthority): RemoteRunnerRecoveryProcess | null {
  const retention = object(lease.metadata?.nativeWarmRunnerRetention), controller = object(retention.controller);
  const authority = nativeRemoteRetentionAuthority(retention);
  const wire = object(retention.runnerIdentity), execution = object(run.runnerProfileJson?.nativeExecutionInput);
  const session = object(execution.session), lifecycle = object(session.lifecyclePolicy);
  const process = remoteRunnerProcessBinding(lease, run);
  const recordedAt = typeof retention.recordedAt === "string" ? Date.parse(retention.recordedAt) : NaN;
  const idleExpiresAt = typeof retention.idleExpiresAt === "string" ? Date.parse(retention.idleExpiresAt) : NaN;
  if (!expected || !authority || !sameRuntimeServiceConfiguration(authority, expected) || retention.version !== 1
    || !coordinator || coordinator.issueId !== run.nativeIssueId
    || retention.companyId !== run.companyId || retention.runId !== run.id || retention.issueId !== run.nativeIssueId
    || retention.agentId !== run.agentId || retention.normalizedSessionId !== run.nativeSessionId
    || !run.nativeSessionId || retention.runnerInstanceId !== run.runnerInstanceId || !run.runnerInstanceId
    || retention.executionDigest !== nativeSha256(execution) || lifecycle.mode !== "warm"
    || !Number.isSafeInteger(lifecycle.idleTimeoutMs) || Number(lifecycle.idleTimeoutMs) <= 0
    || !Number.isFinite(recordedAt) || idleExpiresAt - recordedAt !== lifecycle.idleTimeoutMs
    || session.normalizedSessionId !== run.nativeSessionId || !/^sha256:[a-f0-9]{64}$/.test(String(retention.sessionConfigDigest))
    || coordinator.controllerBootId !== controller.bootId || coordinator.controllerPid !== controller.pid
    || coordinator.controllerProcessStartedAt?.toISOString() !== controller.processStartedAt
    || coordinator.controllerGeneration !== controller.generation || coordinator.attempt !== controller.attempt
    || wire.runId !== run.id || wire.runnerInstanceId !== run.runnerInstanceId || wire.normalizedSessionId !== run.nativeSessionId
    || ![wire.environmentLeaseId, wire.turnId, wire.itemId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0"))
    || !process || !sameRuntimeServiceConfiguration(retention.process, process)) return null;
  return process;
}

function retainedRunnerProcess(lease: Lease, run: Run, coordinator: typeof nativeRunFinalizations.$inferSelect | undefined,
  expected: RemoteRunnerRetentionAuthority): RemoteRunnerRecoveryProcess | null {
  if (!["active", "retained"].includes(lease.status) || !["succeeded", "failed"].includes(run.status) || coordinator?.phase !== "committed") return null;
  return retainedRunnerBinding(lease, run, coordinator, expected);
}

export type NativeRemoteIdleBinding = { companyId: string; runId: string; expectedProcess: RemoteRunnerRecoveryProcess; expectedRetention: RemoteRunnerRetentionAuthority };
export type NativeRemoteIdleControllerClaimInput = NativeRemoteIdleBinding & { reconnectionEvidence?: NativeRemoteIdleReconnectionEvidence };
export type NativeRemoteIdleStatus = "ready" | "recovering" | "finalizing" | "superseded" | "closing" | "closed" | "unverified";
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Reads lifecycle only. Pending or superseded evidence grants no provider access. */
async function currentIdleBinding(tx: Pick<Db, "select" | "execute">, input: NativeRemoteIdleBinding) {
  const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, input.expectedProcess.environmentLeaseId), eq(environmentLeases.companyId, input.companyId)));
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId)));
  if (!lease || !run || !coordinator) return null;
  const process = retainedRunnerBinding(lease, run, coordinator, input.expectedRetention);
  if (!process || !sameRuntimeServiceConfiguration(process, input.expectedProcess)) return null;
  await assertRuntimeServiceLeaseDataAvailable(tx, lease);
  const retention = object(lease.metadata?.nativeWarmRunnerRetention);
  let status: NativeRemoteIdleStatus;
  if (retention.allocationRunLeasesDigest !== await nativeRunnerAllocationLeaseDigest(tx, lease)) status = "superseded";
  else if (!["active", "retained"].includes(lease.status)) status = "unverified";
  else if (coordinator.phase === "committed" && ["succeeded", "failed"].includes(run.status)) {
    const closure = object(lease.metadata?.nativeWarmRunnerClose);
    const reconnection = idleReconnection(retention);
    status = lease.metadata?.nativeWarmRunnerClose
      ? closure.version === 1 && closure.retentionNonce === input.expectedRetention.nonce
        ? closure.state === "closed" ? "closed" : "closing" : "unverified"
      : reconnection && reconnection.state !== "attached" ? "recovering" : "ready";
  } else if (["running", "succeeded", "failed"].includes(run.status) && coordinator.phase !== "terminal_failure"
    && (!coordinator.leaseOwner || coordinator.leaseOwner.startsWith("native-finalizer:"))) status = "finalizing";
  else status = "unverified";
  return { lease, process, status };
}

async function withIdleBinding<T>(db: Db, input: NativeRemoteIdleBinding, work: (tx: Transaction, current: NonNullable<Awaited<ReturnType<typeof currentIdleBinding>>>) => Promise<T>) {
  const lock = { id: input.expectedProcess.environmentLeaseId, companyId: input.companyId, provider: "daytona", providerLeaseId: input.expectedProcess.providerLeaseId };
  return withRuntimeServiceLeaseLock(db, lock, async tx => {
    const current = await currentIdleBinding(tx, input);
    return current ? work(tx, current) : null;
  });
}

export async function nativeRemoteIdleStatus(db: Db, input: NativeRemoteIdleBinding): Promise<NativeRemoteIdleStatus> {
  return await withIdleBinding(db, input, async (_tx, current) => current.status) ?? "unverified";
}

/** Commit shutdown admission before any PRP command. New run acquisition uses
 * the same allocation lock and refuses this marker until verified completion. */
export async function claimNativeRemoteIdleClose(db: Db, input: NativeRemoteIdleBinding): Promise<string | null> {
  return withIdleBinding(db, input, async (tx, { lease, status }) => {
    if (status !== "ready") return null;
    const nonce = randomUUID();
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeWarmRunnerClose: {
      version: 1, nonce, retentionNonce: input.expectedRetention.nonce, state: "closing", requestedAt: new Date().toISOString(),
    } }, updatedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
    return nonce;
  });
}

/** Called only after the controller's exact process inspection proves exit.
 * A failed or lost completion keeps the close marker; elapsed time cannot clear it. */
export async function finishNativeRemoteIdleClose(db: Db, input: NativeRemoteIdleBinding, nonce: string): Promise<boolean> {
  return await withIdleBinding(db, input, async (tx, { lease, status }) => {
    const closure = object(lease.metadata?.nativeWarmRunnerClose);
    if (status !== "closing" || closure.nonce !== nonce || closure.state !== "closing") return false;
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeWarmRunnerClose: {
      ...closure, state: "closed", finishedAt: new Date().toISOString(),
    } }, updatedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
    return true;
  }) ?? false;
}

/** Only the admitted close can publish its settled checkpoint. Keeping this
 * receipt on the close itself distinguishes it from a prior run's backup. */
export async function recordNativeRemoteIdleCheckpoint(db: Db, input: NativeRemoteIdleBinding, nonce: string, stamp: NativeHarnessBackupStamp): Promise<boolean> {
  return await withIdleBinding(db, input, async (tx, { lease, status }) => {
    const closure = object(lease.metadata?.nativeWarmRunnerClose), retention = object(lease.metadata?.nativeWarmRunnerRetention);
    if (status !== "closing" || closure.state !== "closing" || closure.nonce !== nonce
      || stamp.normalizedSessionId !== retention.normalizedSessionId || stamp.runnerInstanceId !== retention.runnerInstanceId
      || stamp.sourceProviderLeaseId !== lease.providerLeaseId
      || !verifyNativeHarnessBackupStamp(stamp, lease.providerLeaseId!, object(retention.runnerIdentity))) return false;
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeHarnessBackup: stamp, nativeWarmRunnerClose: {
      ...closure, checkpoint: { version: 1, stamp, recordedAt: new Date().toISOString() },
    } }, updatedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
    return true;
  }) ?? false;
}

async function idleControllerHasStopped(authority: RemoteRunnerRetentionAuthority): Promise<boolean> {
  try { process.kill(authority.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  try {
    const observed = await readProcessStartedAt(authority.pid);
    // Whole-second ps precision must not turn an ambiguous live PID into
    // permission to finish another controller's close.
    return observed !== null && Math.abs(Date.parse(observed) - Date.parse(authority.processStartedAt)) >= 1_000;
  } catch { return false; }
}

/** Transfer only idle process control, under the allocation lock. A completed
 * run is never reopened and a live or unverifiable controller is never evicted.
 * Session reattachment optionally reserves the allocation in this same write;
 * the reservation is settled only after separate authenticated PRP recovery. */
export async function claimNativeRemoteIdleController(db: Db, input: NativeRemoteIdleControllerClaimInput,
  inspect: (lease: Lease, params: Pick<PluginEnvironmentRunProcessControlParams, "owner" | "operation" | "workspaceConnection">) => Promise<PluginEnvironmentRunProcessControlResult>,
): Promise<NativeRemoteWarmRetention | null> {
  if (input.reconnectionEvidence !== undefined && !validReconnectionEvidence(input.reconnectionEvidence)) return null;
  const evidence = input.reconnectionEvidence === undefined ? undefined : structuredClone(input.reconnectionEvidence);
  const controller = await currentNativeControllerIdentity();
  return withIdleBinding(db, input, async (tx, before) => {
    if (!(before.status === "ready" || (before.status === "recovering" && evidence))
      || !await idleControllerHasStopped(input.expectedRetention)) return null;
    const retention = object(before.lease.metadata?.nativeWarmRunnerRetention);
    const generation = Number(object(retention.controllerTakeover).generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) return null;
    let observed: PluginEnvironmentRunProcessControlResult;
    try { observed = await inspect(before.lease, { owner: before.process.remoteProcessIdentity,
      operation: { action: "inspect" }, workspaceConnection: before.process.workspaceConnection }); }
    catch { return null; }
    if (observed.state !== "running" || !sameRuntimeServiceConfiguration(observed.workspaceConnection, before.process.workspaceConnection)) return null;
    const after = await currentIdleBinding(tx, input);
    if (!after || after.status !== before.status || !sameRuntimeServiceConfiguration(after.lease.metadata?.nativeWarmRunnerRetention, retention)
      || !await idleControllerHasStopped(input.expectedRetention)) return null;
    const now = new Date();
    const authority = { nonce: randomUUID(), bootId: controller.bootId, pid: controller.pid, processStartedAt: controller.processStartedAt.toISOString() };
    const claimed = { ...retention, controllerTakeover: {
      version: 1, originNonce: retention.nonce, generation, previousAuthoritySha256: nativeSha256(input.expectedRetention), claimedAt: now.toISOString(),
      authority,
      ...(evidence ? { reconnection: { version: 1, nonce: randomUUID(), authorityNonce: authority.nonce,
        state: "attaching", evidence, startedAt: now.toISOString() } } : {}),
    } } as unknown as NativeRemoteWarmRetention;
    await tx.update(environmentLeases).set({ metadata: { ...after.lease.metadata, nativeWarmRunnerRetention: claimed }, updatedAt: now })
      .where(and(eq(environmentLeases.id, after.lease.id), eq(environmentLeases.companyId, input.companyId)));
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "native-idle-recovery",
      action: "environment.runner_idle_controller_recovered", entityType: "environment_lease", entityId: after.lease.id,
      runId: input.runId, details: { generation, reason: "verified_controller_exit" } });
    return claimed;
  });
}

/** Reattachment grants transport access only. In particular it does not
 * reopen the completed run or admit model turns, shutdown or workspace exec. */
export async function nativeRemoteIdleReconnectionAdmitted(db: Db, input: NativeRemoteIdleBinding, nonce: string): Promise<boolean> {
  return await withIdleBinding(db, input, async (_tx, { lease, status }) => {
    const marker = idleReconnection(lease.metadata?.nativeWarmRunnerRetention);
    return (status === "recovering" || status === "ready") && marker?.nonce === nonce
      && (marker.state === "attaching" || marker.state === "attached");
  }) ?? false;
}

/** Publish only after authenticated recovery and supervisor installation.
 * Failures retain the allocation hold; a later controller must prove this
 * controller has exited and take a fresh epoch before another attempt. */
export async function settleNativeRemoteIdleReconnection(db: Db, input: NativeRemoteIdleBinding, nonce: string,
  outcome: "attached" | "failed"): Promise<boolean> {
  if (outcome !== "attached" && outcome !== "failed") return false;
  const controller = await currentNativeControllerIdentity();
  if (input.expectedRetention.bootId !== controller.bootId || input.expectedRetention.pid !== controller.pid
    || input.expectedRetention.processStartedAt !== controller.processStartedAt.toISOString()) return false;
  return await withIdleBinding(db, input, async (tx, { lease, status }) => {
    const retention = object(lease.metadata?.nativeWarmRunnerRetention), marker = idleReconnection(retention);
    if ((status !== "recovering" && status !== "ready") || marker?.nonce !== nonce) return false;
    if (marker.state !== "attaching") return marker.state === outcome;
    const now = new Date();
    await tx.update(environmentLeases).set({ metadata: { ...lease.metadata, nativeWarmRunnerRetention: {
      ...retention, controllerTakeover: { ...object(retention.controllerTakeover),
        reconnection: { ...marker, state: outcome, settledAt: now.toISOString() } },
    } }, updatedAt: now }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, input.companyId)));
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "native-idle-recovery",
      action: "environment.runner_idle_reconnection_settled", entityType: "environment_lease", entityId: lease.id,
      runId: input.runId, details: { outcome } });
    return true;
  }) ?? false;
}

/** Caller holds this physical allocation's lock. Resolves only a lost final
 * close write: it grants no command, signal, ingress or runner takeover. */
export async function reconcileNativeRemoteIdleClosures(tx: Transaction, allocation: Pick<Lease, "companyId" | "provider" | "providerLeaseId">,
  inspect: (lease: Lease, params: Pick<PluginEnvironmentRunProcessControlParams, "owner" | "operation" | "workspaceConnection">) => Promise<PluginEnvironmentRunProcessControlResult>,
): Promise<number> {
  if (allocation.provider !== "daytona" || !allocation.providerLeaseId) return 0;
  const candidates = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, allocation.companyId),
    eq(environmentLeases.provider, allocation.provider), eq(environmentLeases.providerLeaseId, allocation.providerLeaseId)));
  let recovered = 0;
  for (const candidate of candidates) {
    const retention = object(candidate.metadata?.nativeWarmRunnerRetention);
    const closure = object(candidate.metadata?.nativeWarmRunnerClose), checkpoint = object(closure.checkpoint);
    if (!candidate.heartbeatRunId || closure.version !== 1 || closure.state !== "closing" || typeof closure.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(closure.nonce)
      || checkpoint.version !== 1 || !sameRuntimeServiceConfiguration(checkpoint.stamp, candidate.metadata?.nativeHarnessBackup)) continue;
    const expectedRetention = nativeRemoteRetentionAuthority(retention);
    if (!expectedRetention) continue;
    const input: NativeRemoteIdleBinding = { companyId: candidate.companyId, runId: candidate.heartbeatRunId,
      expectedProcess: retention.process as RemoteRunnerRecoveryProcess, expectedRetention };
    if (!input.expectedProcess || input.expectedProcess.environmentLeaseId !== candidate.id
      || input.expectedProcess.providerLeaseId !== allocation.providerLeaseId) continue;
    const verify = async () => {
      const current = await currentIdleBinding(tx, input);
      if (!current || current.status !== "closing") return null;
      const latestClose = object(current.lease.metadata?.nativeWarmRunnerClose), latestCheckpoint = object(latestClose.checkpoint);
      const stamp = object(latestCheckpoint.stamp);
      if (latestClose.state !== "closing" || latestClose.nonce !== closure.nonce || latestCheckpoint.version !== 1
        || !sameRuntimeServiceConfiguration(latestCheckpoint, checkpoint)
        || !sameRuntimeServiceConfiguration(stamp, current.lease.metadata?.nativeHarnessBackup)
        || stamp.normalizedSessionId !== retention.normalizedSessionId || stamp.runnerInstanceId !== retention.runnerInstanceId
        || stamp.sourceProviderLeaseId !== allocation.providerLeaseId
        || !verifyNativeHarnessBackupStamp(stamp, allocation.providerLeaseId!, object(retention.runnerIdentity))
        || !await idleControllerHasStopped(expectedRetention)) return null;
      return current;
    };
    const before = await verify();
    if (!before) continue;
    let observed: PluginEnvironmentRunProcessControlResult;
    try { observed = await inspect(before.lease, { owner: before.process.remoteProcessIdentity,
      operation: { action: "inspect" }, workspaceConnection: before.process.workspaceConnection }); }
    catch { continue; }
    if (observed.state !== "exited" || !sameRuntimeServiceConfiguration(observed.workspaceConnection, before.process.workspaceConnection)) continue;
    const after = await verify();
    if (!after) continue;
    await tx.update(environmentLeases).set({ metadata: { ...after.lease.metadata, nativeWarmRunnerClose: {
      ...object(after.lease.metadata?.nativeWarmRunnerClose), state: "closed", finishedAt: new Date().toISOString(),
      recovery: { version: 1, reason: "verified_checkpoint_after_controller_exit" },
    } }, updatedAt: new Date() }).where(eq(environmentLeases.id, after.lease.id));
    await logActivity(tx as unknown as Db, { companyId: candidate.companyId, actorType: "system", actorId: "native-idle-recovery",
      action: "environment.runner_idle_close_recovered", entityType: "environment_lease", entityId: candidate.id,
      runId: candidate.heartbeatRunId, details: { reason: "verified_checkpoint_after_controller_exit" } });
    recovered += 1;
  }
  return recovered;
}

/** Shared admission guard for acquisition, compute release and destruction.
 * Incomplete shutdown or reattachment holds every alias of the allocation. */
export async function assertNoNativeRunnerClosing(db: Pick<Db, "select">, lease: Pick<Lease, "companyId" | "provider" | "providerLeaseId">) {
  if (!lease.provider || !lease.providerLeaseId) return;
  const rows = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
  if (rows.some(row => row.metadata?.nativeWarmRunnerClose && object(row.metadata.nativeWarmRunnerClose).state !== "closed")) {
    throw new Error("native_remote_runner_idle_close_pending");
  }
  if (rows.some(row => object(object(row.metadata?.nativeWarmRunnerRetention).controllerTakeover).reconnection !== undefined
    && (idleReconnection(row.metadata?.nativeWarmRunnerRetention)?.state !== "attached"
      || !nativeRemoteRetentionAuthority(row.metadata?.nativeWarmRunnerRetention)))) {
    throw new Error("native_remote_runner_idle_recovery_pending");
  }
  const retained = rows.filter(row => row.metadata?.nativeWarmRunnerRetention && !row.metadata.nativeWarmRunnerClose);
  if (!retained.length) return;
  const membership = await nativeRunnerAllocationLeaseDigest(db, lease);
  const controller = await currentNativeControllerIdentity();
  for (const row of retained) {
    const retention = object(row.metadata?.nativeWarmRunnerRetention);
    // An earlier, successfully handed-off epoch cannot hold its successor.
    // Missing membership evidence is uncertainty, not proof of a handoff.
    if (/^[a-f0-9]{64}$/.test(String(retention.allocationRunLeasesDigest))
      && retention.allocationRunLeasesDigest !== membership) continue;
    const authority = nativeRemoteRetentionAuthority(retention);
    if (!authority || authority.bootId !== controller.bootId || authority.pid !== controller.pid
      || authority.processStartedAt !== controller.processStartedAt.toISOString()) {
      // Provider inspection may fail before a takeover marker can be written.
      // Preserve the old membership until recovery can establish supervision.
      throw new Error("native_remote_runner_idle_recovery_pending");
    }
  }
}

/** Internal recovery capability. No allocation, replacement, wake or workspace
 * synchronization is authorized by an inspection or signal request. */
async function withRemoteRunnerProcess<T>(db: Db, input: {
  companyId: string; runId: string; environmentLeaseId: string; expectedOwner?: RemoteProcessIdentity; expectedProcess?: RemoteRunnerRecoveryProcess;
  expectedController?: RemoteRunnerRecoveryController;
  expectedRetention?: RemoteRunnerRetentionAuthority;
  expectedIdleCloseNonce?: string;
  expectedIdleReconnectionNonce?: string;
}, call: (lease: Lease, process: RemoteRunnerRecoveryProcess, run: Run) => Promise<T>): Promise<{ process: RemoteRunnerRecoveryProcess; value: T } | null> {
  const [initial] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.id, input.environmentLeaseId),
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (!initial) return null;
  return withRuntimeServiceLeaseLock(db, initial, async tx => {
    async function current() {
      const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, initial.id), eq(environmentLeases.companyId, input.companyId)));
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      if (!lease || !run || lease.providerLeaseId !== initial.providerLeaseId || lease.environmentId !== initial.environmentId) return null;
      // Restart claims take this allocation lock before changing controller
      // ownership. Check here, not before waiting for the lock: a queued stale
      // signal or command must never reach the provider after takeover.
      if (input.expectedController !== undefined && input.expectedRetention !== undefined) return null;
      if (input.expectedIdleCloseNonce !== undefined && input.expectedRetention === undefined) return null;
      if (input.expectedIdleReconnectionNonce !== undefined && (input.expectedRetention === undefined || input.expectedIdleCloseNonce !== undefined)) return null;
      if (input.expectedRetention !== undefined) {
        const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
        const process = retainedRunnerProcess(lease, run, coordinator, input.expectedRetention);
        if (!process) return null;
        const marker = idleReconnection(lease.metadata?.nativeWarmRunnerRetention);
        if (input.expectedIdleReconnectionNonce !== undefined) {
          if (typeof input.expectedIdleReconnectionNonce !== "string" || !input.expectedIdleReconnectionNonce
            || marker?.nonce !== input.expectedIdleReconnectionNonce || !["attaching", "attached"].includes(marker.state)
            || lease.metadata?.nativeWarmRunnerClose !== undefined) return null;
        } else if (marker && marker.state !== "attached") return null;
        if (input.expectedIdleCloseNonce !== undefined) {
          const closure = object(lease.metadata?.nativeWarmRunnerClose);
          if (typeof input.expectedIdleCloseNonce !== "string" || !input.expectedIdleCloseNonce
            || closure.version !== 1 || closure.state !== "closing" || closure.nonce !== input.expectedIdleCloseNonce
            || closure.retentionNonce !== input.expectedRetention.nonce) return null;
        }
        // New lease creation shares this allocation lock. Changed membership
        // supersedes the earlier authority even if clocks move backwards or a
        // successor has already finished. Removal also requires new evidence.
        const digest = await nativeRunnerAllocationLeaseDigest(tx, lease);
        return object(lease.metadata?.nativeWarmRunnerRetention).allocationRunLeasesDigest === digest ? { lease, process, run } : null;
      }
      if (input.expectedController !== undefined) {
        const expected = input.expectedController;
        if (!expected || typeof expected.leaseOwner !== "string" || !expected.leaseOwner
          || !Number.isSafeInteger(expected.controllerGeneration) || expected.controllerGeneration < 0) return null;
        const [controller] = await tx.select().from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
        if (!controller || controller.issueId !== run.nativeIssueId || controller.leaseOwner !== expected.leaseOwner
          || controller.controllerGeneration !== expected.controllerGeneration || !controller.leaseExpiresAt
          || controller.leaseExpiresAt.getTime() <= Date.now()) return null;
      }
      const process = remoteRunnerRecoveryProcess(lease, run);
      return process ? { lease, process, run } : null;
    }
    const before = await current();
    if (!before || (input.expectedOwner && !sameRuntimeServiceConfiguration(input.expectedOwner, before.process.remoteProcessIdentity))
      || (input.expectedProcess && !sameRuntimeServiceConfiguration(input.expectedProcess, before.process))) return null;
    await assertRuntimeServiceLeaseDataAvailable(tx, before.lease);
    let value: T;
    try { value = await call(before.lease, before.process, before.run); }
    catch { return null; }
    const after = await current();
    if (!after || !sameRuntimeServiceConfiguration(after.process, before.process) || after.run.nativeSessionId !== before.run.nativeSessionId) return null;
    return { process: before.process, value };
  });
}

export async function operateRemoteRunProcess(db: Db, input: RemoteRunProcessControlInput,
  call: (lease: Lease, params: Pick<PluginEnvironmentRunProcessControlParams, "owner" | "operation" | "workspaceConnection">) => Promise<PluginEnvironmentRunProcessControlResult>,
): Promise<RemoteRunProcessControlResult> {
  const unverified = { state: "unverified" } as const;
  if (input.operation.action !== "inspect" && !input.expectedOwner) return unverified;
  if (input.expectedRetention !== undefined && input.operation.action === "stop_group") return unverified;
  const checked = await withRemoteRunnerProcess(db, input, (lease, process) => call(lease, {
    owner: process.remoteProcessIdentity, operation: input.operation, workspaceConnection: process.workspaceConnection,
  }));
  if (!checked || !sameRuntimeServiceConfiguration(checked.value.workspaceConnection, checked.process.workspaceConnection)) return unverified;
  const accepted = input.operation.action === "inspect" ? ["running", "exited", "mismatch"]
    : input.operation.action === "signal" ? ["signalled", "exited", "mismatch"] : ["stopped"];
  return accepted.includes(checked.value.state) ? { state: checked.value.state, process: checked.process } : unverified;
}

export interface RemoteRunnerRecoveryInput {
  companyId: string; runId: string; expectedProcess: RemoteRunnerRecoveryProcess; operation: "ingress" | "read_state";
  expectedController?: RemoteRunnerRecoveryController;
  expectedRetention?: RemoteRunnerRetentionAuthority;
  expectedIdleReconnectionNonce?: string;
}
export interface RemoteRunnerRecoveryExecutionInput extends Omit<RemoteRunnerRecoveryInput, "operation"> {
  /** Separate shutdown capability for host checkpoint work, never ordinary idle execution. */
  expectedIdleCloseNonce?: string;
  execution: PluginEnvironmentRunnerRecoveryExecuteParams["execution"];
}

export async function operateRemoteRunnerRecoveryExecution(db: Db, input: RemoteRunnerRecoveryExecutionInput,
  call: (lease: Lease, params: Pick<PluginEnvironmentRunnerRecoveryExecuteParams, "owner" | "workspaceConnection" | "workspaceRoot" | "execution">) => Promise<PluginEnvironmentRunnerRecoveryExecuteResult>,
): Promise<PluginEnvironmentRunnerRecoveryExecuteResult> {
  if ((input.expectedRetention !== undefined && input.expectedIdleCloseNonce === undefined) || !input.expectedProcess || !input.execution || (input.execution.timeoutMs !== undefined &&
    (!Number.isFinite(input.execution.timeoutMs) || input.execution.timeoutMs <= 0 || input.execution.timeoutMs > 120_000))) return { state: "unverified" };
  const checked = await withRemoteRunnerProcess(db, { ...input, environmentLeaseId: input.expectedProcess.environmentLeaseId }, (lease, process, run) =>
    run.nativeSessionId ? call(lease, { owner: process.remoteProcessIdentity, workspaceConnection: process.workspaceConnection,
      workspaceRoot: process.workspaceRoot, execution: input.execution }) : Promise.resolve({ state: "unverified" } as const));
  if (!checked || checked.value.state !== "executed" || !sameRuntimeServiceConfiguration(checked.value.workspaceConnection, checked.process.workspaceConnection)) return { state: "unverified" };
  const result = checked.value.result;
  if (!result || result.timedOut || result.exitCode === null || !Number.isInteger(result.exitCode)
    || typeof result.stdout !== "string" || typeof result.stderr !== "string") return { state: "unverified" };
  return checked.value;
}
/** Session/path and provider selection come only from persisted host ownership. */
export async function operateRemoteRunnerRecovery(db: Db, input: RemoteRunnerRecoveryInput,
  call: (lease: Lease, params: Pick<PluginEnvironmentRunnerRecoveryParams, "owner" | "operation" | "workspaceConnection" | "workspaceRoot" | "sessionHash" | "runId">) => Promise<PluginEnvironmentRunnerRecoveryResult>,
): Promise<PluginEnvironmentRunnerRecoveryResult> {
  const unverified = { state: "unverified" } as const;
  if (!input.expectedProcess || !["ingress", "read_state"].includes(input.operation)) return unverified;
  if (input.expectedRetention !== undefined && input.operation !== "read_state" && input.expectedIdleReconnectionNonce === undefined) return unverified;
  const checked = await withRemoteRunnerProcess(db, { ...input, environmentLeaseId: input.expectedProcess.environmentLeaseId }, async (lease, process, run) => {
    if (!run.nativeSessionId) return unverified;
    return call(lease, { owner: process.remoteProcessIdentity, workspaceConnection: process.workspaceConnection,
      workspaceRoot: process.workspaceRoot, runId: run.id, sessionHash: createHash("sha256").update(run.nativeSessionId).digest("hex"), operation: input.operation });
  });
  if (!checked || checked.value.state !== "ready" || !sameRuntimeServiceConfiguration(checked.value.workspaceConnection, checked.process.workspaceConnection)) return unverified;
  if (input.operation === "ingress" ? !("endpoint" in checked.value) : !("runnerState" in checked.value)) return unverified;
  return checked.value;
}

/** Reuse the same lease row without acquire/resume or expiry changes. Current
 * execution policy must still equal the policy captured before original launch. */
export async function adoptRemoteRunnerLease(db: Db, input: {
  companyId: string; runId: string; agentId: string; issueId: string | null; environmentId: string;
  executionWorkspaceId: string | null; taskWorkspaceId: string | null; configurationDigest: string; pluginId: string;
  expectedProcess: RemoteRunnerRecoveryProcess;
}, inspect: (lease: Lease, process: RemoteRunnerRecoveryProcess) => Promise<PluginEnvironmentRunProcessControlResult>): Promise<Lease | null> {
  const checked = await withRemoteRunnerProcess(db, { companyId: input.companyId, runId: input.runId,
    environmentLeaseId: input.expectedProcess.environmentLeaseId, expectedProcess: input.expectedProcess }, async (lease, process, run) => {
    const scope = runtimeServiceRunScopeSchema.safeParse(lease.metadata?.runtimeServiceRunScope);
    if (!scope.success || scope.data.pluginId !== input.pluginId || scope.data.configurationDigest !== input.configurationDigest
      || process.environmentId !== input.environmentId || run.agentId !== input.agentId || lease.issueId !== input.issueId
      || lease.executionWorkspaceId !== input.executionWorkspaceId
      || (scope.data.version === 1 ? scope.data.executionWorkspaceId !== input.executionWorkspaceId || input.taskWorkspaceId !== null
        : scope.data.taskWorkspaceId !== input.taskWorkspaceId)) return null;
    const result = await inspect(lease, process);
    return result.state === "running" && sameRuntimeServiceConfiguration(result.workspaceConnection, process.workspaceConnection) ? lease : null;
  });
  return checked?.value ?? null;
}
