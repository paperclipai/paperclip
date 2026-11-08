import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { inspectFinalizedWorkspaceRecoveryHold, type FinalizedWorkspaceRecoveryHold } from "./finalized-workspace-recovery-migration.js";
import { isLegacyWorkspaceTaskRelated, readLegacyWorkspaceRecoveryAllocations, type LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { inspectWorkspaceRecoverySource, WorkspaceSourceInspectionLimit, workspaceExportCauses } from "./workspace-recovery-source.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { readSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { readWorkspaceRecovery } from "./workspace-recovery-receipt.js";

type ReadDb = Pick<Db, "select">;
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "sourceIssueId">;
type Recovery = typeof issueRecoveryActions.$inferSelect;
export const ONLINE_LEGACY_WORKSPACE_PRESERVATION = "paperclip.online-legacy-workspace-preservation.v1";

function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

async function settledRun(db: ReadDb, workspace: Workspace, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, workspace.companyId), eq(heartbeatRuns.id, runId)));
  if (!run || run.runtimeMode !== "native" || !run.nativeIssueId
    || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)
    || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()
    || adapterExecutionControls.has(run.id)
    || run.runnerProfileJson?.nativeWorkspaceFinalizationOwner != null
    || run.runnerProfileJson?.remoteWorkspace != null
    || !await isLegacyWorkspaceTaskRelated(db, { companyId: workspace.companyId,
      issueId: run.nativeIssueId, sourceIssueId: workspace.sourceIssueId })) return null;
  const [owner] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, workspace.companyId), eq(nativeRunFinalizations.runId, run.id),
    eq(nativeRunFinalizations.issueId, run.nativeIssueId)));
  if (!owner || owner.leaseOwner !== null) return null;
  return { run, owner };
}

export async function inspectOnlineLegacyWorkspaceRecoverySource(db: ReadDb, input: {
  workspace: Workspace; runId: string;
}): Promise<LegacyWorkspaceRecoverySource | null> {
  const settled = await settledRun(db, input.workspace, input.runId);
  if (!settled) return null;
  const { run, owner } = settled;
  const unresolved = ["observed", "retryable_failure"].includes(owner.phase) && owner.resultId === null;
  if (!["committed", "terminal_failure"].includes(owner.phase) && !unresolved) return null;
  const raw = run.runnerProfileJson?.nativeWorkspaceSync;
  const reference = readNativeWorkspaceSyncReference(raw);
  if (raw != null && !reference || reference && (reference.workspaceId !== input.workspace.id || reference.state !== "prepared")) return null;
  if (!reference && !unresolved) return null;
  const recoveryAllocations = await readLegacyWorkspaceRecoveryAllocations(db, run);
  if (run.resultJson?.workspaceRestoreRecovery != null && !recoveryAllocations) return null;
  const retainedAllocations = [];
  for (const source of recoveryAllocations ?? []) {
    const [lease] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.workspace.companyId), eq(environmentLeases.id, source.leaseId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.issueId, run.nativeIssueId!)));
    if (!lease?.environmentId || !lease.provider || lease.provider === "local"
      || lease.providerLeaseId !== source.providerLeaseId || lease.metadata?.remoteCwd !== source.remoteCwd) return null;
    retainedAllocations.push(lease);
  }
  let allocation = null;
  if (reference) {
    const [lease] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.workspace.companyId), eq(environmentLeases.id, reference.leaseId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.issueId, run.nativeIssueId!)));
    if (!lease || !lease.environmentId || !lease.provider || lease.provider === "local"
      || lease.providerLeaseId !== reference.providerLeaseId || lease.metadata?.remoteCwd !== reference.remoteCwd
      || lease.executionWorkspaceId && lease.executionWorkspaceId !== input.workspace.id) return null;
    allocation = lease;
  }
  const source: LegacyWorkspaceRecoverySource = { runId: run.id, issueId: run.nativeIssueId!, reference,
    ...(recoveryAllocations ? { recoveryAllocations } : {}),
    ...(unresolved ? { unresolvedFinalization: { phase: owner.phase, leaseOwner: null,
      leaseExpiresAt: owner.leaseExpiresAt?.toISOString() ?? null } } : {}) };
  return { ...source, onlineProof: { schema: ONLINE_LEGACY_WORKSPACE_PRESERVATION,
    fingerprint: fingerprint({ workspace: { id: input.workspace.id, companyId: input.workspace.companyId,
      sourceIssueId: input.workspace.sourceIssueId }, source, allocation, retainedAllocations, owner, run }) } };
}

export async function lockOnlineLegacyWorkspaceRecoverySources(lock: Db, input: {
  companyId: string; sources: readonly LegacyWorkspaceRecoverySource[];
  holds?: readonly OnlineLegacyWorkspaceRecoveryHold[];
}): Promise<boolean> {
  const runIds = new Set<string>();
  for (const source of input.sources) {
    if (source.onlineProof?.schema !== ONLINE_LEGACY_WORKSPACE_PRESERVATION
      || !/^[a-f0-9]{64}$/.test(source.onlineProof.fingerprint)) return false;
    runIds.add(source.runId);
  }
  for (const hold of input.holds ?? []) {
    if (!/^[a-f0-9]{64}$/.test(hold.fingerprint)) return false;
    if (hold.finalizedHold) runIds.add(hold.finalizedHold.runId);
    if (hold.preparedSource) {
      if (hold.preparedSource.onlineProof?.schema !== ONLINE_LEGACY_WORKSPACE_PRESERVATION
        || !/^[a-f0-9]{64}$/.test(hold.preparedSource.onlineProof.fingerprint)
        || hold.preparedSource.reference?.state !== "prepared") return false;
      runIds.add(hold.preparedSource.runId);
    }
  }
  for (const runId of [...runIds].sort()) {
    if (!await tryLockNativeWorkspaceFinalization(lock, { companyId: input.companyId, runId })) return false;
  }
  return true;
}

export type OnlineLegacyWorkspaceRecoveryHold = {
  fingerprint: string; finalizedHold: FinalizedWorkspaceRecoveryHold | null;
  preparedSource?: LegacyWorkspaceRecoverySource;
};

async function coveredHistoricalSource(db: ReadDb, workspace: Workspace, recovery: Recovery, source: LegacyWorkspaceRecoverySource) {
  const raw = recovery.evidence.historicalWorkspaceSource;
  if (raw == null) return true;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  const historical = raw as Record<string, unknown>, ids = historical.leaseIds;
  const covered = new Map([...(source.reference ? [source.reference] : []), ...(source.recoveryAllocations ?? [])]
    .map(binding => [binding.leaseId, binding]));
  if (historical.schema !== "paperclip.historical-workspace-source.v1" || historical.runId !== source.runId
    || Object.keys(historical).some(key => !["schema", "runId", "leaseIds"].includes(key))
    || !Array.isArray(ids) || !ids.length || ids.length > covered.size || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== "string" || !covered.has(id))) return false;
  try {
    const inspected = await inspectWorkspaceRecoverySource(db as Db, { companyId: workspace.companyId,
      issueId: source.issueId, runId: source.runId, actionId: recovery.id }, { maximumSources: covered.size });
    const verifiedIds = new Set(inspected.sources.map(item => item.lease.id));
    return ids.every(id => verifiedIds.has(id)) && inspected.sources.every(item => {
      const binding = covered.get(item.lease.id);
      return binding && binding.providerLeaseId === item.lease.providerLeaseId && binding.remoteCwd === item.remoteCwd;
    });
  } catch (error) {
    if (error instanceof SystemRecoveryFailure || error instanceof WorkspaceSourceInspectionLimit) return false;
    throw error;
  }
}

export async function inspectOnlineLegacyWorkspaceRecoveryHold(db: ReadDb, input: {
  workspace: Workspace; recovery: Recovery;
}): Promise<OnlineLegacyWorkspaceRecoveryHold | null> {
  const { recovery } = input;
  if (recovery.companyId !== input.workspace.companyId || !["active", "escalated"].includes(recovery.status) || !await isLegacyWorkspaceTaskRelated(db, {
    companyId: input.workspace.companyId, issueId: recovery.sourceIssueId, sourceIssueId: input.workspace.sourceIssueId,
  })) return null;
  const fileKeys = ["workspaceRestoreRecovery", "workspaceRecovery", "historicalWorkspaceSource", "systemRecovery", "nativeFailureBlock"];
  if (["stranded_assigned_issue", "configuration_validation", "missing_disposition", "deliberate_wait_without_target"].includes(recovery.kind)
    && !workspaceExportCauses.includes(recovery.cause) && !fileKeys.some(key => recovery.evidence?.[key] != null)) {
    return { fingerprint: fingerprint(recovery), finalizedHold: null };
  }
  if (typeof recovery.evidence?.runId !== "string") return null;
  const settled = await settledRun(db, input.workspace, recovery.evidence.runId);
  if (!settled) return null;
  const failureBlock = recovery.evidence.nativeFailureBlock as { runId?: unknown; statusVersion?: unknown } | undefined;
  if (recovery.kind === "active_run_watchdog" && recovery.status === "active"
    && ["runner_remote_provider_artifact_incompatible", "native_session_interrupted"].includes(recovery.cause) && settled.run.status === "failed"
    && settled.owner.phase === "terminal_failure" && settled.owner.nextAttemptAt === null && settled.owner.resultId === null
    && settled.owner.failureCode === recovery.cause && recovery.sourceIssueId === settled.run.nativeIssueId
    && recovery.ownerType === "board" && recovery.ownerAgentId === null && recovery.returnOwnerAgentId === settled.run.agentId
    && recovery.wakePolicy === null && recovery.evidence.sourceFailureCode === recovery.cause
    && recovery.evidence.recoveryDisposition === recovery.cause
    && (recovery.cause === "native_session_interrupted"
      ? typeof recovery.evidence.providerSessionEstablished === "boolean" && recovery.evidence.recoveryMode === "ambiguous_state"
      : recovery.evidence.providerSessionEstablished === true && recovery.evidence.recoveryMode === "exact_checkpoint_resume")
    && failureBlock?.runId === settled.run.id
    && Number.isSafeInteger(failureBlock.statusVersion) && Number(failureBlock.statusVersion) > 0
    && recovery.fingerprint === createHash("sha256").update(`${settled.run.id}:${recovery.cause}`).digest("hex")
    && !fileKeys.filter(key => key !== "nativeFailureBlock").some(key => recovery.evidence?.[key] != null)) {
    const [task] = await db.select({ id: issues.id, status: issues.status, statusVersion: issues.statusVersion,
      executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(and(
      eq(issues.companyId, input.workspace.companyId), eq(issues.id, recovery.sourceIssueId)));
    if (!task || task.status !== "blocked" || task.statusVersion !== failureBlock.statusVersion
      || task.executionRunId !== null || task.checkoutRunId !== null) return null;
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: input.workspace, runId: settled.run.id });
    if (source?.reference?.state === "prepared" && source.issueId === recovery.sourceIssueId && source.recoveryAllocations?.length)
      return { fingerprint: fingerprint({ recovery, source, task }), finalizedHold: null, preparedSource: source };
  }
  if (recovery.kind === "active_run_watchdog" && workspaceExportCauses.includes(recovery.cause)
    && settled.owner.phase === "terminal_failure" && settled.owner.nextAttemptAt === null
    && settled.owner.failureCode === recovery.cause && recovery.ownerType === "board"
    && recovery.ownerAgentId === null && recovery.returnOwnerAgentId === settled.run.agentId && recovery.wakePolicy === null
    && recovery.fingerprint === nativeSha256({ runId: settled.run.id, failureCode: recovery.cause })
    && !fileKeys.some(key => recovery.evidence?.[key] != null)) {
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: input.workspace, runId: settled.run.id });
    if (source?.reference?.state === "prepared" && source.issueId === recovery.sourceIssueId)
      return { fingerprint: fingerprint({ recovery, source }), finalizedHold: null, preparedSource: source };
  }
  const system = readSystemRecovery(recovery.evidence), workspaceRecovery = readWorkspaceRecovery(recovery.evidence);
  if (recovery.kind === "active_run_watchdog" && recovery.status === "active"
    && recovery.cause === "native_workspace_sync_out_retry_exhausted" && settled.run.status === "failed"
    && settled.owner.phase === "terminal_failure" && settled.owner.nextAttemptAt === null && settled.owner.resultId
    && settled.owner.failureCode === recovery.cause && settled.run.completionContractId
    && recovery.sourceIssueId === settled.run.nativeIssueId && ["system", "board"].includes(recovery.ownerType)
    && recovery.ownerAgentId === null && recovery.returnOwnerAgentId === settled.run.agentId && recovery.wakePolicy === null
    && recovery.fingerprint === nativeSha256({ runId: settled.run.id, failureCode: recovery.cause })
    && system?.sourceRunId === settled.run.id && system.state === "exhausted" && system.nextAttemptAt === null
    && workspaceRecovery?.runId === settled.run.id && workspaceRecovery.status === "blocked"
    && !["workspaceRestoreRecovery", "nativeFailureBlock"].some(key => recovery.evidence?.[key] != null)) {
    const [task] = await db.select({ id: issues.id, status: issues.status, statusVersion: issues.statusVersion,
      executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId }).from(issues).where(and(
      eq(issues.companyId, input.workspace.companyId), eq(issues.id, recovery.sourceIssueId)));
    const [result] = await db.select().from(nativeRunResults).where(and(
      eq(nativeRunResults.companyId, input.workspace.companyId), eq(nativeRunResults.issueId, recovery.sourceIssueId),
      eq(nativeRunResults.runId, settled.run.id), eq(nativeRunResults.id, settled.owner.resultId),
      eq(nativeRunResults.completionContractId, settled.run.completionContractId), eq(nativeRunResults.schemaStatus, "accepted")));
    if (!task || task.status !== "blocked" || task.executionRunId !== null || task.checkoutRunId !== null || !result) return null;
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace: input.workspace, runId: settled.run.id });
    if (source?.reference?.state === "prepared" && source.issueId === recovery.sourceIssueId
      && await coveredHistoricalSource(db, input.workspace, recovery, source))
      return { fingerprint: fingerprint({ recovery, system, workspaceRecovery, source, task, result }), finalizedHold: null, preparedSource: source };
  }
  const held = await inspectFinalizedWorkspaceRecoveryHold(db, {
    companyId: input.workspace.companyId, workspaceId: input.workspace.id, recovery,
  });
  if (!held) return null;
  const proof = fingerprint({ recovery, held, settled });
  return { fingerprint: proof, finalizedHold: { ...held, source: held.source ? { ...held.source,
    onlineProof: { schema: ONLINE_LEGACY_WORKSPACE_PRESERVATION, fingerprint: proof } } : null } };
}
