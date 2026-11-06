import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { inspectFinalizedWorkspaceRecoveryHold, type FinalizedWorkspaceRecoveryHold } from "./finalized-workspace-recovery-migration.js";
import { isLegacyWorkspaceTaskRelated, readLegacyWorkspaceRecoveryAllocations, type LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { workspaceExportCauses } from "./workspace-recovery-source.js";

type ReadDb = Pick<Db, "select">;
type Workspace = Pick<typeof executionWorkspaces.$inferSelect, "id" | "companyId" | "sourceIssueId">;
type Recovery = Parameters<typeof inspectFinalizedWorkspaceRecoveryHold>[1]["recovery"];
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
  }
  for (const runId of [...runIds].sort()) {
    if (!await tryLockNativeWorkspaceFinalization(lock, { companyId: input.companyId, runId })) return false;
  }
  return true;
}

export type OnlineLegacyWorkspaceRecoveryHold = {
  fingerprint: string; finalizedHold: FinalizedWorkspaceRecoveryHold | null;
};

export async function inspectOnlineLegacyWorkspaceRecoveryHold(db: ReadDb, input: {
  workspace: Workspace; recovery: Recovery;
}): Promise<OnlineLegacyWorkspaceRecoveryHold | null> {
  const { recovery } = input;
  if (!["active", "escalated"].includes(recovery.status) || !await isLegacyWorkspaceTaskRelated(db, {
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
  const held = await inspectFinalizedWorkspaceRecoveryHold(db, {
    companyId: input.workspace.companyId, workspaceId: input.workspace.id, recovery,
  });
  if (!held) return null;
  const proof = fingerprint({ recovery, held, settled });
  return { fingerprint: proof, finalizedHold: { ...held, source: held.source ? { ...held.source,
    onlineProof: { schema: ONLINE_LEGACY_WORKSPACE_PRESERVATION, fingerprint: proof } } : null } };
}
