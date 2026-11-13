import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests, assets, environmentLeases, environments, executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns,
  issueAttachments, issueRecoveryActions, issues, nativeRunFinalizations, statusDecisionEffects, toolInvocations, workspaceOperations, type Db,
} from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type Environment, type EnvironmentLease, type ExecutionReconciliation } from "@paperclipai/shared";
import { createTarballFromDirectory } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { logger } from "../middleware/logger.js";
import { assertWorkspaceFilePathAllowed } from "./workspace-file-resources.js";
import { getSecretProvider } from "../secrets/provider-registry.js";
import { getStorageService } from "../storage/index.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { notifyRoutineExecutionStatus } from "./routine-execution-status-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { abandonUnverifiedRemoteWorkspaceEpoch } from "./remote-workspace-epoch-abandonment.js";
import { hasStopOnlyCleanup, prepareHistoricalSandboxStopVerification, prepareSandboxStopAndRetain, restoreSandboxStopAfterFailedRestart, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { holdOwnsBlockedStatus } from "./recovery-hold-blocked-status.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { NATIVE_NO_REPLAY_HOLD_CAUSE, PERMANENT_SOURCE_RETRY_CLASSES, RETAINED_SOURCE_FALLBACK_CHECK_KEY, UNVERIFIABLE_SOURCE_CODES, isRetainedFileHold,
  retainedHoldFallbackEligible } from "./workspace-recovery-fallback-discovery.js";
import { captureReadOnlyWorkspaceArchive, sandboxProviderFailureLabel } from "./remote-workspace-transport.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { readSystemRecovery, type SystemRecoveryState } from "./system-recovery-state.js";
import { readWorkspaceRecovery, verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";

/**
 * Automatic fallback for a retained-file hold whose recorded source can never
 * be verified (for example a reusable sandbox chain that crosses tasks). The
 * strict source check stays in force: unverified files are never applied. The
 * task continues from its last committed workspace save instead, and the
 * unverified files are attached to the task when they can still be read.
 */
export const RETAINED_SOURCE_FALLBACK_OUTCOME = "retained_source_unverifiable_continued_from_last_saved" as const;
export const RETAINED_SOURCE_FALLBACK_SCHEMA = "paperclip.retained-source-fallback.v1" as const;
export const SIBLING_WORKSPACE_RECOVERY_SCHEMA = "paperclip.sibling-workspace-recovery.v1" as const;
export const RETAINED_SOURCE_QUARANTINE_PHASE = "workspace_recovery_quarantine";

const terminal = ["failed", "interrupted", "timed_out", "cancelled", "succeeded"];
// A check deferred for a transient reason runs again after this delay, a bounded number of times.
const FALLBACK_RECHECK_MS = 5 * 60_000;
const FALLBACK_MAX_CHECKS = 12;
const outOfScopeReasons = ["not_unverifiable_source_hold", "not_remote_workspace_source"];
const transientReasons = ["writer_active", "workspace_operation_running", "execution_not_stopped", "side_effect_pending",
  "allocation_in_use", "ownership_busy", "fallback_failed", "source_changed"];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Source = { companyId: string; issueId: string; runId: string; actionId: string };
type Ownership = { token: string; assertHeld(): Promise<void> };
type Quarantine = NonNullable<ExecutionReconciliation["retainedSourceFallback"]>["quarantine"];
export type RetainedSourceFallbackResult = { kind: "continued" | "settled" } | { kind: "ineligible"; reason: string };

export function isUnverifiableSourceFailure(failure: SystemRecoveryState["failure"] | null | undefined) {
  return Boolean(failure && (UNVERIFIABLE_SOURCE_CODES as readonly string[]).includes(failure.code)
    && (PERMANENT_SOURCE_RETRY_CLASSES as readonly string[]).includes(failure.retryClass));
}

/** Text the agent receives with its continuation. It names no person who must act. */
export function retainedSourceFallbackNote(input: { runId: string; snapshotId: string | null; quarantine: Quarantine }) {
  const from = input.snapshotId ? `the last saved version of the workspace (snapshot ${input.snapshotId})` : "the workspace's original source";
  const files = input.quarantine.state === "captured"
    ? `They are attached to this task as ${input.quarantine.filename} (attachment ${input.quarantine.attachmentId}), without secrets, repository metadata or dependency directories. Inspect them and re-apply anything still needed deliberately.`
    : "They could not be read, so they are not available.";
  return `Paperclip could not verify the unsaved file changes of run ${input.runId}, so they were not applied. `
    + `This task continues from ${from}. ${files} Check which work from that run needs redoing. `
    + "Its completed external actions remain recorded and must not be repeated.";
}

async function uncertainExternalAction(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  for (const receipt of Object.values(object(run.resultJson?.apiToolReceipts)).map(object)) {
    let result = object(receipt.result);
    if (receipt.encryptedResult) {
      try {
        result = object(JSON.parse(await getSecretProvider("local_encrypted").resolveVersion({ material: object(receipt.encryptedResult), externalRef: null })));
      } catch { return true; }
    }
    if (receipt.state !== "completed" || result.outcome === "unknown" || result.error === "api_outcome_unknown") return true;
    // A definite client rejection had no effect. Anything else that is not ok is unknown.
    const definiteRejection = result.ok === false && typeof result.status === "number" && result.status >= 400 && result.status < 500 && result.status !== 408;
    if (result.ok !== true && !definiteRejection) return true;
  }
  // Semantic control-plane receipts are written in the same transaction as
  // their effect, so they are never uncertain. Upstream tool calls can be.
  const [invocation] = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(
    eq(toolInvocations.companyId, run.companyId), eq(toolInvocations.runId, run.id),
    sql`${toolInvocations.riskLevel} is distinct from 'read'`,
    inArray(toolInvocations.status, ["executing", "failed", "timed_out"]),
    sql`${toolInvocations.startedAt} is not null`)).limit(1);
  return Boolean(invocation);
}

/** Every fact the fallback depends on, read in the existing lock order:
 * task, coordinator, run, recovery action, then workspace. */
async function inspectFallback(db: Db, input: Source, lock: boolean, requireStopped = lock) {
  const one = async <T>(query: PromiseLike<T[]> & { for(mode: "update"): PromiseLike<T[]> }): Promise<T | null> =>
    (await (lock ? query.for("update") : query))[0] ?? null;
  const refuse = (reason: string) => ({ kind: "ineligible" as const, reason });
  const issue = await one(db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1));
  const coordinator = await one(db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, input.runId))).limit(1));
  const run = await one(db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1));
  const action = await one(db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).limit(1));
  if (!issue || !run || !action) return refuse("source_changed");
  if (object(action.evidence.retainedSourceFallback).schema === RETAINED_SOURCE_FALLBACK_SCHEMA) return { kind: "settled" as const };
  const system = readSystemRecovery(action.evidence);
  if (!isRetainedFileHold(action) || action.evidence.runId !== run.id
    || action.evidence.executionReconciliation || system?.state !== "exhausted" || system.sourceRunId !== run.id
    || !retainedHoldFallbackEligible(action.evidence, system)) return refuse("not_unverifiable_source_hold");
  if (run.runtimeMode !== "native" || !terminal.includes(run.status) || !run.finishedAt
    || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issue.id) return refuse("source_run_not_terminal");
  // No second executor: the source run, its controller and its finalizer have stopped.
  if (adapterExecutionControls.has(run.id) || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())
    || coordinator?.leaseOwner || coordinator?.failureDetail?.successorRunId) return refuse("execution_not_stopped");
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!parsed.success || parsed.data.state !== "prepared") return refuse("not_remote_workspace_source");
  const reference = parsed.data;
  const workspace = await one(db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, reference.workspaceId))).limit(1));
  let authority;
  try { authority = readRemoteWorkspaceAuthority(workspace?.metadata); } catch { return refuse("workspace_authority_invalid"); }
  // Only the exact epoch this run wrote is abandoned; a newer writer is never touched.
  if (!workspace || !authority?.location || authority.writerRunId !== run.id || authority.epoch !== reference.epoch
    || authority.snapshotId !== reference.snapshotId || authority.location.leaseId !== reference.leaseId
    || authority.location.providerLeaseId !== reference.providerLeaseId || authority.location.remoteCwd !== reference.remoteCwd) {
    return refuse("workspace_authority_changed");
  }
  if (reference.snapshotId) {
    const [snapshot] = await db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, input.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
      eq(executionWorkspaceSnapshots.id, reference.snapshotId), eq(executionWorkspaceSnapshots.status, "committed"))).limit(1);
    if (!snapshot) return refuse("last_save_missing");
  }
  // A live writer keeps its files. A queued turn of this task that never
  // started cannot write: this hold gates its dispatch.
  const [writer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), ne(heartbeatRuns.id, run.id), inArray(heartbeatRuns.status, ["queued", "running"]),
    sql`not coalesce(${heartbeatRuns.status} = 'queued' and ${heartbeatRuns.startedAt} is null
      and ${heartbeatRuns.processPid} is null and ${heartbeatRuns.processGroupId} is null, false)`,
    or(eq(heartbeatRuns.nativeIssueId, issue.id), eq(heartbeatRuns.issueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${workspace.id}`))).limit(1);
  if (writer) return refuse("writer_active");
  // No second executor: every allocation of the source run has a provider stop receipt.
  if (requireStopped) {
    const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.heartbeatRunId, run.id)));
    if (!leases.some(lease => lease.id === reference.leaseId)
      || leases.some(lease => !hasRemoteTerminationReceipt(lease) && !hasRecoveredCleanupStopReceipt(lease))) return refuse("execution_not_stopped");
  }
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.executionWorkspaceId, workspace.id),
    eq(workspaceOperations.status, "running"))).limit(1);
  if (operation) return refuse("workspace_operation_running");
  // Pending and uncertain effects keep the existing reconciliation path.
  const [effect] = coordinator?.decisionId ? await db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(and(
    eq(statusDecisionEffects.companyId, input.companyId), eq(statusDecisionEffects.issueId, issue.id),
    eq(statusDecisionEffects.decisionId, coordinator.decisionId), inArray(statusDecisionEffects.deliveryState, ["pending", "failed"]))).limit(1) : [];
  if (effect) return refuse("side_effect_pending");
  if (await uncertainExternalAction(db, run)) return refuse("external_action_uncertain");
  return { kind: "eligible" as const, issue, coordinator, run, action, system, reference, workspace, authority };
}

/** The attachment follows the workspace file policy: secrets (such as `.env`
 * and keys), repository metadata and dependency or build directories are omitted. */
async function omitDeniedWorkspaceFiles(root: string, relative = "") {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    let allowed = true;
    try { assertWorkspaceFilePathAllowed(child); } catch { allowed = false; }
    if (!allowed) await rm(path.join(root, child), { recursive: true, force: true });
    else if (entry.isDirectory() && !entry.isSymbolicLink()) await omitDeniedWorkspaceFiles(root, child);
  }
}

function unreadable(reason: string): Quarantine {
  return { state: "unreadable", reason: /^[a-z][a-z0-9_]{0,47}$/.test(reason) ? reason : "operation_failed" };
}

/** Reads the retained root without writing to the sandbox and attaches it to
 * the task as an unverified archive. Never applied, never a recovery receipt.
 * A root that cannot be read is recorded as such. Storage and database
 * failures after a successful read throw, so the fallback retries later. */
async function quarantineRetainedRoot(db: Db, input: Source & { environmentRuntime: EnvironmentRuntimeService; ownership: Ownership },
  source: Extract<Awaited<ReturnType<typeof inspectFallback>>, { kind: "eligible" }>): Promise<Quarantine> {
  const [existing] = await db.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.heartbeatRunId, input.runId),
    eq(workspaceOperations.phase, RETAINED_SOURCE_QUARANTINE_PHASE), eq(workspaceOperations.status, "succeeded"),
    sql`${workspaceOperations.metadata}->>'recoveryActionId' = ${input.actionId}`)).limit(1);
  const saved = object(existing?.metadata?.quarantine);
  if (saved.state === "captured") return saved as Quarantine;
  const { reference } = source;
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (!lease?.environmentId || lease.providerLeaseId !== reference.providerLeaseId) return unreadable("allocation_missing");
  if (hasRemoteTerminationReceipt(lease) && object(lease.metadata?.remoteExecutionTermination).state === "destroyed")
    return unreadable("sandbox_destroyed");
  const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
  if (!environment) return unreadable("environment_missing");
  const scratch = await mkdtemp(path.join(os.tmpdir(), "paperclip-quarantine-"));
  try {
    const tarball = path.join(scratch, "unverified.tar");
    try {
      const target = await resolveEnvironmentExecutionTarget({ db, companyId: input.companyId, adapterType: "paperclip_runner",
        environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as EnvironmentLease, environmentRuntime: input.environmentRuntime });
      if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner) return unreadable("target_unavailable");
      await input.ownership.assertHeld();
      const captured = await captureReadOnlyWorkspaceArchive({ target, remoteCwd: reference.remoteCwd, operationId: randomUUID() });
      const files = path.join(scratch, "files");
      try {
        await restoreRemoteWorkspaceArchive({ archivePath: captured.archivePath, targetDir: files, expectedManifestDigest: captured.manifestDigest });
      } finally { await captured.cleanup(); }
      await omitDeniedWorkspaceFiles(files);
      await createTarballFromDirectory({ localDir: files, archivePath: tarball });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const reason = /^remote_workspace_readonly_capture_failed: .*reason=([a-z_]+)/.exec(message)?.[1];
      logger.warn({ err: error, runId: input.runId }, "Unverified retained files could not be read; continuing from the last save");
      return unreadable(reason ?? sandboxProviderFailureLabel(error).label);
    }
    const hash = createHash("sha256");
    let byteSize = 0;
    for await (const chunk of createReadStream(tarball)) { hash.update(chunk as Buffer); byteSize += (chunk as Buffer).length; }
    const sha256 = hash.digest("hex");
    const filename = `unverified-files-run-${input.runId}.tar`;
    await input.ownership.assertHeld();
    const stored = await getStorageService().putFile({ companyId: input.companyId, namespace: "workspace-recovery-quarantine",
      objectKey: `${input.companyId}/workspace-recovery-quarantine/${input.runId}/${sha256}.tar`, originalFilename: filename,
      contentType: "application/x-tar", body: createReadStream(tarball), byteSize, sha256 });
    await input.ownership.assertHeld();
    return await db.transaction(async tx => {
      const [asset] = await tx.insert(assets).values({ companyId: input.companyId, provider: stored.provider, objectKey: stored.objectKey,
        contentType: "application/x-tar", byteSize, sha256, originalFilename: filename }).returning();
      const [attachment] = await tx.insert(issueAttachments).values({ companyId: input.companyId, issueId: input.issueId,
        assetId: asset!.id }).returning();
      const quarantine: Quarantine = { state: "captured", attachmentId: attachment!.id, filename, sha256, byteSize };
      await tx.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId, heartbeatRunId: input.runId,
        executionWorkspaceId: source.workspace.id, phase: RETAINED_SOURCE_QUARANTINE_PHASE, status: "succeeded", finishedAt: new Date(),
        metadata: { schema: RETAINED_SOURCE_FALLBACK_SCHEMA, recoveryActionId: input.actionId, verified: false, applied: false,
          leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: reference.remoteCwd, epoch: reference.epoch, quarantine } });
      return quarantine;
    });
  } finally { await rm(scratch, { recursive: true, force: true }).catch(() => undefined); }
}

async function sandboxHeldByAnotherLease(db: Db, lease: Pick<typeof environmentLeases.$inferSelect, "id" | "provider" | "providerLeaseId">) {
  if (!lease.provider || !lease.providerLeaseId) return false;
  const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
    inArray(environmentLeases.status, ["active", "pending_cleanup"]))).limit(1);
  return Boolean(other);
}

/** Obtains the provider stop receipt for the source allocation through the
 * same stop-only cleanup as normal recovery. A sandbox that another lease holds
 * is never stopped from here. */
async function confirmSourceAllocationStopped(db: Db, input: Source & { environmentRuntime: EnvironmentRuntimeService; ownership: Ownership },
  leaseId: string): Promise<"stopped" | "in_use" | "unconfirmed"> {
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (!lease?.environmentId || !lease.provider || !lease.providerLeaseId) return "unconfirmed";
  if (hasRemoteTerminationReceipt(lease) || hasRecoveredCleanupStopReceipt(lease)) return "stopped";
  if (await sandboxHeldByAnotherLease(db, lease)) return "in_use";
  const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
  if (!environment) return "unconfirmed";
  await input.ownership.assertHeld();
  const pending = await db.transaction(async tx => {
    const [fresh] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.id, lease.id))).for("update");
    if (!fresh || fresh.metadata?.pendingCleanupInFlight === true) return null;
    const prepared = hasStopOnlyCleanup(fresh) ? fresh : fresh.status === "released"
      ? await prepareHistoricalSandboxStopVerification(tx as unknown as Db, fresh)
      : await prepareSandboxStopAndRetain(tx as unknown as Db, fresh);
    if (!prepared) return null;
    const [claimed] = await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} ||
      ${JSON.stringify({ pendingCleanupAttemptId: input.ownership.token, pendingCleanupInFlight: true,
        pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000 })}::jsonb` }).where(eq(environmentLeases.id, lease.id)).returning();
    return claimed ?? null;
  });
  if (!pending) return "unconfirmed";
  const attemptId = input.ownership.token;
  const settled = await input.environmentRuntime.retryPendingSandboxTeardown({ environment: environment as unknown as Environment,
    lease: pending as EnvironmentLease })
    .then(receipt => settleStopOnlyCleanup(db, pending, { attemptId, receipt }),
      async () => await restoreSandboxStopAfterFailedRestart(db, pending, { attemptId }) ?? await settleStopOnlyCleanup(db, pending, { attemptId }));
  return settled && hasRemoteTerminationReceipt(settled) ? "stopped" : "unconfirmed";
}

/**
 * Settles a retained-file hold whose source can never be verified. In one
 * transaction it abandons the unverified workspace epoch, resolves the hold
 * with a named outcome, and hands the task to its normal continuation from the
 * last committed save. Waiting user input continues the task itself; otherwise
 * the recovery delivery starts one continuation. Bounded and idempotent: a
 * settled hold is never revisited, and a lost race leaves the hold unchanged.
 */
export async function continueFromLastSavedWorkspace(input: Source & {
  db: Db; environmentRuntime: EnvironmentRuntimeService; ownership: Ownership;
}): Promise<RetainedSourceFallbackResult> {
  const { db } = input;
  const initial = await inspectFallback(db, input, false);
  if (initial.kind !== "eligible") return initial;
  // An unstopped source in a sandbox another lease holds waits; nothing is read or stopped.
  const [sourceLease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, initial.reference.leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (sourceLease && !hasRemoteTerminationReceipt(sourceLease) && !hasRecoveredCleanupStopReceipt(sourceLease)
    && await sandboxHeldByAnotherLease(db, sourceLease)) return { kind: "ineligible", reason: "allocation_in_use" };
  // Read before stopping: a stopped sandbox cannot be read without resuming it.
  const quarantine = await quarantineRetainedRoot(db, input, initial);
  const stop = await confirmSourceAllocationStopped(db, input, initial.reference.leaseId);
  if (stop !== "stopped") return { kind: "ineligible", reason: stop === "in_use" ? "allocation_in_use" : "execution_not_stopped" };
  await input.ownership.assertHeld();
  const outcome = await db.transaction(async tx => {
    const current = await inspectFallback(tx as unknown as Db, input, true);
    if (current.kind !== "eligible") return { result: current, publication: null };
    if (current.system.generationId !== initial.system.generationId || current.system.revision !== initial.system.revision)
      return { result: { kind: "ineligible" as const, reason: "source_changed" }, publication: null };
    const { issue, run, action, reference } = current;
    const abandoned = await abandonUnverifiedRemoteWorkspaceEpoch(tx, { companyId: input.companyId, workspaceId: reference.workspaceId,
      runId: run.id, epoch: reference.epoch, snapshotId: reference.snapshotId, location: current.authority.location! });
    const [waitingInput] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(agentWakeupRequests.requestedByActorType, "user"), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`)).limit(1);
    const fallback: NonNullable<ExecutionReconciliation["retainedSourceFallback"]> = { schema: RETAINED_SOURCE_FALLBACK_SCHEMA,
      outcome: RETAINED_SOURCE_FALLBACK_OUTCOME, workspaceId: reference.workspaceId, abandonedEpoch: reference.epoch,
      epoch: abandoned.authority.epoch, snapshotId: reference.snapshotId, quarantine };
    const decision: ExecutionReconciliation = { runId: run.id, providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: retainedSourceFallbackNote({ runId: run.id, snapshotId: reference.snapshotId, quarantine }),
      // The workspace repair that a restore failure requires before continuing:
      // the unverified epoch is abandoned and the next writer restores the last
      // committed save into a new root.
      workspaceRepairEvidence: `Paperclip abandoned unverified workspace epoch ${reference.epoch} of run ${run.id}; `
        + `the continuation restores ${reference.snapshotId ? `committed snapshot ${reference.snapshotId}` : "the workspace source"} into a new root.`,
      retainedSourceFallback: fallback };
    const now = new Date();
    // A Blocked status belongs to this hold only while its own receipt (or, for
    // holds saved before receipts existed, a block set by this run's terminal
    // failure that nothing changed since) still names it. Otherwise a newer
    // decision owns the block: it is kept and no continuation is started.
    const ownsBlock = holdOwnsBlockedStatus(action, issue, run);
    const dispatchable = issue.status !== "blocked" || ownsBlock;
    const userText = quarantine.state === "captured"
      ? "Paperclip could not verify the previous run's unsaved files, so the task continues from the last saved version. Those files are attached to the task, unapplied."
      : "Paperclip could not verify the previous run's unsaved files, so the task continues from the last saved version. Those files could not be read.";
    const evidence = { ...action.evidence, automaticRecovery: undefined, [RETAINED_SOURCE_FALLBACK_CHECK_KEY]: undefined,
      retainedSourceFallback: { ...fallback, failureCode: current.system.failure?.code ?? null, recordedAt: now.toISOString() },
      workspaceRecovery: { ...(readWorkspaceRecovery(action.evidence) ?? {}), message: userText, retryable: false },
      executionReconciliation: { ...decision, actorId: "workspace-recovery", recordedAt: now.toISOString() },
      // Saved user input continues the task through normal admission.
      continuationDelivery: waitingInput || !dispatchable ? "not_requested" : "pending" };
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      ownerType: "system", ownerAgentId: null, ownerUserId: null, returnOwnerAgentId: action.returnOwnerAgentId ?? run.agentId,
      resolutionNote: RETAINED_SOURCE_FALLBACK_OUTCOME, nextAction: userText, wakePolicy: null, monitorPolicy: null, evidence,
    }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
    // The abandoned source must never be replayed or replaced automatically.
    await tx.update(nativeRunFinalizations).set({ failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb)
      || ${JSON.stringify({ replacementDenied: RETAINED_SOURCE_FALLBACK_OUTCOME })}::jsonb` }).where(and(
      eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (ownsBlock) {
      await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
        blockedOwnerNotifiedAt: null, updatedAt: now }).where(eq(issues.id, issue.id));
    }
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
    await notifyStatusCardIssueChange(tx, input.companyId);
    await notifyRoutineExecutionStatus(tx, issue.id, input.companyId);
    const publication = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system",
      actorId: "workspace-recovery", action: "issue.workspace_recovery_continued_from_last_saved", entityType: "issue",
      entityId: issue.id, runId: run.id, details: { recoveryActionId: action.id, failureCode: current.system.failure?.code ?? null,
        ...fallback } });
    return { result: { kind: "continued" as const }, publication };
  });
  if (outcome.publication) {
    try { publishActivity(outcome.publication.publication); } catch { logger.warn({ runId: input.runId }, "Recovery activity delivery deferred"); }
  }
  return outcome.result;
}

/** Records why the fallback could not settle this generation yet. A transient
 * reason is checked again after a delay, a bounded number of times; a
 * permanent one waits for new input, Retry or a new recovery generation. */
export async function recordRetainedSourceFallbackDeferral(db: Db, input: Source, reason: string) {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.id, input.actionId)));
  const system = readSystemRecovery(row?.evidence);
  // A hold outside the fallback's scope keeps its evidence unchanged.
  if (!row || !system || row.evidence.retainedSourceFallback || outOfScopeReasons.includes(reason)) return;
  const prior = object(row.evidence[RETAINED_SOURCE_FALLBACK_CHECK_KEY]);
  const checks = prior.generationId === system.generationId && typeof prior.checks === "number" ? prior.checks + 1 : 1;
  const transient = transientReasons.includes(reason) && checks < FALLBACK_MAX_CHECKS;
  const marker = { generationId: system.generationId, reason, checks, checkedAt: Date.now(),
    nextCheckAt: transient ? Date.now() + FALLBACK_RECHECK_MS : null };
  await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} ||
    jsonb_build_object(${RETAINED_SOURCE_FALLBACK_CHECK_KEY}::text, ${JSON.stringify(marker)}::jsonb)` }).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId),
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}' = ${system.generationId}`,
    sql`${issueRecoveryActions.evidence}->'retainedSourceFallback' is null`));
}

/**
 * The recovery worker's entry for an exhausted hold: settle it when a sibling
 * saved its files, or continue from the last save when its source is refused
 * permanently or its stop stayed unproven through every bounded re-arm. Runs under the workspace ownership lock, like any physical
 * recovery attempt. Returns whether the hold is settled.
 */
export async function settleExhaustedRetainedHold(input: Source & { db: Db; environmentRuntime: EnvironmentRuntimeService },
  state: SystemRecoveryState, options: { fallback: boolean } = { fallback: true }) {
  const { db } = input;
  const sibling = await settleSiblingRecoveredHold(db, input);
  if (sibling === "settled") return true;
  const [row] = options.fallback ? await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.id, input.actionId))) : [];
  if (!options.fallback || !retainedHoldFallbackEligible(row?.evidence, state)) {
    // A sibling marked recovered without a receipt that still verifies cannot
    // settle this hold. Record it so discovery does not select it again.
    if (sibling === "unverified") await recordRetainedSourceFallbackDeferral(db, input, "sibling_receipt_unverified");
    return false;
  }
  let reason: string;
  try {
    const owned = await withNativeWorkspaceFinalizationOwnership({ db, companyId: input.companyId, runId: input.runId,
      retainedRepairActionId: input.actionId }, ownership => continueFromLastSavedWorkspace({ ...input, ownership }));
    if (owned.acquired && owned.value.kind !== "ineligible") return true;
    reason = !owned.acquired ? "ownership_busy" : owned.value.kind === "ineligible" ? owned.value.reason : "fallback_failed";
  } catch (error) {
    logger.warn({ err: error, runId: input.runId }, "Continuing from the last save was deferred; the hold remains");
    reason = "fallback_failed";
  }
  logger.info({ runId: input.runId, reason }, "Retained source fallback deferred");
  await recordRetainedSourceFallbackDeferral(db, input, reason);
  return false;
}

/**
 * An exhausted hold for a run whose files another recovery action already
 * saved (a verified receipt bound to that sibling) has nothing left to do.
 * Settle it as recovered instead of handing a spent budget to a person.
 */
export async function settleSiblingRecoveredHold(db: Db, input: Source) {
  const settled = await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.id, input.runId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId))).for("update");
    if (!issue || !run || !action || action.evidence.runId !== run.id) return null;
    if (object(action.evidence.siblingWorkspaceRecovery).schema === SIBLING_WORKSPACE_RECOVERY_SCHEMA) return "already" as const;
    // isRetainedFileHold also accepts export holds; only the no-replay cause
    // may release the status here. An export hold leaves it to its result.
    const noReplayHold = action.cause === NATIVE_NO_REPLAY_HOLD_CAUSE && isRetainedFileHold(action);
    const system = readSystemRecovery(action.evidence);
    // A no-replay hold is recorded resolved-but-blocked. It blocks the task
    // until its run's files are saved, so a sibling's save settles it too.
    if ((!["active", "escalated"].includes(action.status) && !noReplayHold)
      || system?.state !== "exhausted" || system.sourceRunId !== run.id) return null;
    const receiptId = await verifiedWorkspaceRepairReceipt(tx as unknown as Db, run);
    const [receipt] = receiptId ? await tx.select({ metadata: workspaceOperations.metadata }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.id, receiptId))) : [];
    const siblingActionId = receipt?.metadata?.recoveryActionId;
    if (!receiptId || typeof siblingActionId !== "string" || siblingActionId === action.id) {
      const [recoveredSibling] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ne(issueRecoveryActions.id, action.id), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
        sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete'`,
        sql`${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' = 'recovered'`)).limit(1);
      return recoveredSibling ? "unverified" as const : null;
    }
    const now = new Date();
    const prior = readWorkspaceRecovery(action.evidence);
    await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now, updatedAt: now,
      ownerType: "system", ownerAgentId: null, ownerUserId: null, nextAction: "Saved work recovered.",
      resolutionNote: "workspace_recovered_by_sibling_action", wakePolicy: null, monitorPolicy: null,
      // With the files saved, a no-replay hold no longer blocks the task.
      // Settling starts no turn; the run's own result decides what continues.
      evidence: { ...action.evidence, automaticRecovery: undefined,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "recovered", stage: "saving_receipts",
          attempt: prior?.attempt ?? system.attempts, attemptLimit: prior?.attemptLimit ?? 6, requestIds: prior?.requestIds ?? [], retryable: false },
        siblingWorkspaceRecovery: { schema: SIBLING_WORKSPACE_RECOVERY_SCHEMA, receiptId, recoveryActionId: siblingActionId,
          recordedAt: now.toISOString() } },
    }).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, action.id)));
    // A no-replay hold that still owns the task's Blocked status releases it,
    // so saved input and normal wakes continue the task. An export hold's
    // status stays with its own result finalization. A newer decision's
    // Blocked status is kept.
    if (noReplayHold && holdOwnsBlockedStatus(action, issue, run)) {
      await tx.update(issues).set({ status: "todo", unblockDescriptor: null, blockedTransitionAt: null,
        blockedOwnerNotifiedAt: null, updatedAt: now }).where(eq(issues.id, issue.id));
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
      await notifyStatusCardIssueChange(tx, input.companyId);
      await notifyRoutineExecutionStatus(tx, issue.id, input.companyId);
    }
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
    return persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
      action: "issue.workspace_recovered", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { recoveryActionId: action.id, recoveredByRecoveryActionId: siblingActionId, receiptId,
        summary: "Saved work recovered by another recovery of the same run." } });
  });
  if (settled === "unverified") return "unverified" as const;
  if (settled && settled !== "already") {
    try { publishActivity(settled.publication); } catch { logger.warn({ runId: input.runId }, "Recovery activity delivery deferred"); }
  }
  return settled ? "settled" as const : "none" as const;
}
