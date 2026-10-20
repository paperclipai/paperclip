import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, environments, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery, type WorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference, readNativeWorkspaceSyncLocalCwd, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { classifyNativeWorkspaceFailure } from "./native-runtime/native-workspace-failure.js";

const exportCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
const terminal = ["failed", "interrupted", "timed_out", "cancelled", "succeeded"];
class RecoveryBlocked extends Error {
  constructor(message: string, readonly code: "stop" | "source" | "writer" = "source") { super(message); }
}
const stopMessage = "Paperclip couldn’t verify that the previous session stopped. This task needs service attention.";
const sourceMessage = "Paperclip couldn’t verify the retained workspace. This task needs service attention.";
type Source = { companyId: string; issueId: string; runId: string; actionId: string };

/** Admission records intent only. No request handler runs physical recovery. */
export async function requestWorkspaceRecovery(input: Source & { db: Db; idempotencyKey: string; actorId: string }) {
  return input.db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
    const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, input.actionId),
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId))).for("update");
    if (!issue || !run || !action || action.evidence.runId !== run.id
      || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issue.id
      || !terminal.includes(run.status) || (!hasRequiredWorkspaceRecovery(run.resultJson) && !exportCauses.includes(action.cause))) {
      throw conflict("The workspace recovery changed. Refresh the task before retrying.");
    }
    const prior = readWorkspaceRecovery(action.evidence);
    if (prior?.requestIds.includes(input.idempotencyKey) || prior?.status === "recovered") return { actionId: action.id, status: prior.status };
    if (prior?.status === "blocked" && !prior.retryable) throw conflict(prior.message ?? sourceMessage);
    const pending = prior && ["queued", "recovering"].includes(prior.status);
    const state: WorkspaceRecovery = pending ? { ...prior!, requestIds: [...prior!.requestIds, input.idempotencyKey] }
      : { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "queued", stage: "verifying_stop",
        attempt: prior?.attempt ?? 0, attemptLimit: (prior?.attempt ?? 0) + 1,
        requestIds: [...(prior?.requestIds ?? []), input.idempotencyKey] };
    await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, workspaceRecovery: state }, updatedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action.id));
    await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.workspace_recovery_requested", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { recoveryActionId: action.id, idempotencyKey: input.idempotencyKey } });
    return { actionId: action.id, status: state.status };
  });
}

/** One source, one physical exporter. This does not accept/commit an old agent
 * result, infer external effects, or create a provider turn or wake request. */
export async function recoverRetainedWorkspace(input: Source & { db: Db; environmentRuntime: EnvironmentRuntimeService }) {
  const { db } = input;
  async function inspect() {
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.issueId), eq(issueRecoveryActions.id, input.actionId)));
    const reference = readNativeWorkspaceSyncReference(run?.runnerProfileJson?.nativeWorkspaceSync);
    if (!run || !action || action.evidence.runId !== run.id || !terminal.includes(run.status)
      || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== input.issueId
      || !reference || (!hasRequiredWorkspaceRecovery(run.resultJson) && !exportCauses.includes(action.cause))) throw new RecoveryBlocked(sourceMessage);
    const recorded = run.resultJson?.workspaceRestoreRecovery as { leaseIds?: unknown } | undefined;
    if (hasRequiredWorkspaceRecovery(run.resultJson) && (!Array.isArray(recorded?.leaseIds)
      || recorded.leaseIds.length !== 1 || recorded.leaseIds[0] !== reference.leaseId)) throw new RecoveryBlocked(sourceMessage);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (coordinator?.leaseOwner || adapterExecutionControls.has(run.id)
      || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) throw new RecoveryBlocked(stopMessage, "stop");
    const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.heartbeatRunId, run.id)));
    if (!lease || lease.issueId !== input.issueId || lease.providerLeaseId !== reference.providerLeaseId
      || !lease.environmentId || lease.leasePolicy === "reuse_by_environment"
      || (lease.executionWorkspaceId && lease.executionWorkspaceId !== reference.workspaceId)) throw new RecoveryBlocked(sourceMessage);
    const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    )).limit(1);
    const [writer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.status, ["queued", "running"]),
      or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.contextSnapshot}->>'executionWorkspaceId' = ${reference.workspaceId}`),
    )).limit(1);
    if (other || writer) throw new RecoveryBlocked("The workspace has another execution owner. Recovery will not overwrite its work.", "writer");
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) throw new RecoveryBlocked(sourceMessage);
    return { run, action, reference, lease, environment };
  }
  const saveState = async (state: WorkspaceRecovery) => {
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{workspaceRecovery}',
      ${JSON.stringify(state)}::jsonb || jsonb_build_object('requestIds', coalesce(${issueRecoveryActions.evidence}#>'{workspaceRecovery,requestIds}', '[]'::jsonb)))`, updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
  };
  // Persist discovery before requesting an old controller's stop proof. The
  // takeover check must bind to this repair intent even on the first sweep.
  await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{workspaceRecovery}',
    ${JSON.stringify({ schema: "paperclip.workspace-recovery.v1", runId: input.runId, status: "queued", stage: "verifying_stop",
      attempt: 0, attemptLimit: 3, requestIds: [] })}::jsonb)`, updatedAt: new Date() })
    .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      eq(issueRecoveryActions.id, input.actionId), sql`${issueRecoveryActions.evidence}->>'runId' = ${input.runId}`,
      sql`not (${issueRecoveryActions.evidence} ? 'workspaceRecovery')`));
  const owned = await withNativeWorkspaceFinalizationOwnership({ db, companyId: input.companyId, runId: input.runId,
    retainedRepairActionId: input.actionId }, async ownership => {
    const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
    let state = readWorkspaceRecovery(action?.evidence ?? null);
    if (state?.status === "recovered" || (state?.retryAt && state.retryAt > Date.now())) return;
    if (state?.status === "blocked") {
      // Cleanup can produce a real stop receipt after the initial inspection.
      // Reconsider that new fact; do not poll the provider for unchanged unknowns.
      if (state.blockerCode !== "stop") return;
      const source = await inspect();
      if (!hasRemoteTerminationReceipt(source.lease)) return;
    }
    if (state && state.attempt >= (state.attemptLimit ?? 3)) {
      await saveState({ ...state, status: "blocked", retryable: true, message: "Recovery couldn’t finish. Your message is saved." });
      return;
    }
    state = { schema: "paperclip.workspace-recovery.v1", runId: input.runId, status: "recovering", stage: "verifying_stop",
      attempt: (state?.attempt ?? 0) + 1, attemptLimit: state?.attemptLimit ?? 3, requestIds: state?.requestIds ?? [] };
    await saveState(state);
    let resumed: Awaited<ReturnType<typeof inspect>> | undefined;
    let cleanupLease: typeof environmentLeases.$inferSelect | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let renewal = Promise.resolve();
    try {
      const source = await inspect();
      // Verify the immutable descriptor's company/workspace binding before any
      // provider call. Its local path cannot be supplied by the caller.
      await readNativeWorkspaceSyncLocalCwd({ runId: source.run.id, companyId: source.run.companyId,
        workspaceId: source.reference.workspaceId, reference: source.reference });
      if (!hasRemoteTerminationReceipt(source.lease)
        || (source.lease.metadata?.remoteExecutionTermination as { state?: string })?.state !== "stopped") throw new RecoveryBlocked(stopMessage, "stop");
      const target = await resolveEnvironmentExecutionTarget({ db, companyId: input.companyId, adapterType: "paperclip_runner",
        environment: source.environment, leaseId: source.lease.id, leaseMetadata: source.lease.metadata,
        lease: source.lease as EnvironmentLease, environmentRuntime: input.environmentRuntime });
      if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner
        || target.remoteCwd !== source.reference.remoteCwd) throw new RecoveryBlocked(sourceMessage);
      await ownership.assertHeld();
      // Atomically fence stop-only cleanup BEFORE an ambiguous resume call.
      cleanupLease = await db.transaction(async tx => {
        const [current] = await tx.select().from(environmentLeases).where(eq(environmentLeases.id, source.lease.id)).for("update");
        if (!current || !hasRemoteTerminationReceipt(current) || current.providerLeaseId !== source.reference.providerLeaseId) throw new RecoveryBlocked(stopMessage, "stop");
        const pending = await prepareStoppedSandboxForRecovery(tx as unknown as Db, current);
        if (!pending) throw new RecoveryBlocked(sourceMessage);
        const [claimed] = await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
          pendingCleanupAttemptId: ownership.token, pendingCleanupInFlight: true, pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000,
        })}::jsonb` }).where(eq(environmentLeases.id, current.id)).returning();
        return claimed;
      });
      resumed = source;
      keepalive = setInterval(() => { renewal = renewal.then(async () => {
        await ownership.assertHeld();
        await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupLeaseExpiresAtMs}', ${JSON.stringify(Date.now() + 15 * 60_000)}::jsonb)` })
          .where(and(eq(environmentLeases.id, source.lease.id), sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${ownership.token}`));
      }).catch(() => undefined); }, 30_000);
      const opened = await input.environmentRuntime.resumeRunLease({ environment: source.environment as unknown as Environment, lease: cleanupLease as EnvironmentLease });
      if (opened?.providerLeaseId !== source.reference.providerLeaseId || opened.metadata?.remoteCwd !== source.reference.remoteCwd) throw new RecoveryBlocked(sourceMessage);
      await ownership.assertHeld();
      await inspect();
      state = { ...state, stage: "restoring_files" }; await saveState(state);
      const copied = await resumeNativeWorkspaceSync({ db, runId: input.runId, target, assertOwnership: ownership.assertHeld });
      if (!copied) throw new RecoveryBlocked(sourceMessage);
      const current = await inspect();
      if (current.reference.state !== "finalized" || !current.reference.finalHostSha256) throw new RecoveryBlocked(sourceMessage);
      state = { ...state, stage: "saving_receipts" }; await saveState(state);
      clearInterval(keepalive); await renewal;
      await ownership.assertHeld();
      const stopped = await input.environmentRuntime.retryPendingSandboxTeardown({ environment: current.environment as unknown as Environment, lease: cleanupLease as EnvironmentLease });
      const settled = await settleStopOnlyCleanup(db, cleanupLease, { attemptId: ownership.token, receipt: stopped });
      cleanupLease = undefined;
      if (!settled || !hasRemoteTerminationReceipt(settled)) throw new RecoveryBlocked(stopMessage, "stop");
      await ownership.assertHeld();
      await db.transaction(async tx => {
        const [locked] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId))).for("update");
        if (!locked || locked.evidence.runId !== input.runId) throw new RecoveryBlocked(sourceMessage);
        const [copy] = await tx.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
          heartbeatRunId: input.runId, executionWorkspaceId: current.lease.executionWorkspaceId,
          phase: "workspace_recovery", status: "succeeded", finishedAt: new Date(),
          metadata: { recoveryActionId: input.actionId, leaseId: settled.id, providerLeaseId: settled.providerLeaseId,
            descriptorSha256: current.reference.descriptorSha256, finalHostSha256: current.reference.finalHostSha256 } }).returning({ id: workspaceOperations.id });
        await tx.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
          heartbeatRunId: input.runId, executionWorkspaceId: current.lease.executionWorkspaceId,
          phase: "workspace_finalize", status: "succeeded", finishedAt: new Date(),
          metadata: { owningService: "workspace_recovery", recoveryReceiptId: copy.id } });
        await tx.update(issueRecoveryActions).set({ evidence: { ...locked.evidence,
          workspaceRecovery: { ...state, requestIds: readWorkspaceRecovery(locked.evidence)?.requestIds ?? [], status: "recovered" } }, updatedAt: new Date() })
          .where(eq(issueRecoveryActions.id, locked.id));
        const activity = await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
          action: "issue.workspace_recovered", entityType: "issue", entityId: input.issueId, runId: input.runId,
          details: { recoveryActionId: input.actionId, summary: "Saved work recovered." } });
        return activity;
      }).then(activity => {
        try { publishActivity(activity.publication); }
        catch { logger.warn({ runId: input.runId }, "Recovered workspace activity delivery deferred"); }
      });
    } catch (error) {
      clearInterval(keepalive); await renewal;
      if (resumed && cleanupLease) {
        // Lost replies leave the same durable stop-only intent for the ordinary
        // cleanup worker; never destroy a source with uncertain copyback.
        try {
          await ownership.assertHeld();
          const receipt = await input.environmentRuntime.retryPendingSandboxTeardown({ environment: resumed.environment as unknown as Environment, lease: cleanupLease as EnvironmentLease });
          await settleStopOnlyCleanup(db, cleanupLease, { attemptId: ownership.token, receipt });
        } catch { /* Stop-only intent remains pinned. */ }
      }
      await ownership.assertHeld();
      const retryable = !(error instanceof RecoveryBlocked) && !classifyNativeWorkspaceFailure(error).permanent;
      const retry = retryable && state.attempt < (state.attemptLimit ?? 3);
      await saveState({ ...state, status: retry ? "queued" : "blocked", retryable,
        ...(error instanceof RecoveryBlocked ? { blockerCode: error.code } : {}),
        ...(retry ? { retryAt: Date.now() + 30_000 } : {}),
        message: error instanceof RecoveryBlocked ? error.message : retryable
          ? "Recovery couldn’t finish. Your message is saved." : sourceMessage });
      logger.warn({ runId: input.runId, retryable, stage: state.stage }, "Workspace recovery did not finish; source retained");
    } finally { clearInterval(keepalive); await renewal; }
  });
  if (!owned.acquired && owned.reason === "owner_unverified") {
    const [run] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
    if (run?.profile?.nativeWorkspaceFinalizationOwner) {
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId)));
      const state = readWorkspaceRecovery(action?.evidence ?? null);
      await saveState({ schema: "paperclip.workspace-recovery.v1", runId: input.runId,
        stage: "verifying_stop", attempt: state?.attempt ?? 0, requestIds: state?.requestIds ?? [],
        status: "blocked", retryable: false, blockerCode: "owner", message: stopMessage });
    }
  }
}

const cursors = new WeakMap<Db, string>();
const workInFlight = new WeakMap<Db, Set<string>>();

/** Destruction is a later cleanup obligation, authorized only by a matching
 * saved-file receipt and the original recorded disposition. */
export async function scheduleRecoveredWorkspaceCleanup(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (!await hasVerifiedWorkspaceRepair(db, run)) return;
  const ref = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (ref?.resourceDisposition !== "destroy") return;
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, ref.leaseId)));
  if (!lease || !hasRemoteTerminationReceipt(lease)) return;
  const [other] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
  )).limit(1);
  if (other) return;
  await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "ephemeral",
    updatedAt: new Date(), metadata: sql`(${environmentLeases.metadata} - 'workspaceRestoreRecovery' - 'remoteExecutionTermination') ||
      ${JSON.stringify({ workspaceRecoveryCleanup: { runId: run.id, descriptorSha256: ref.descriptorSha256 },
        pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0, pendingCleanupLeaseExpiresAtMs: 0 })}::jsonb`,
  }).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, ref.leaseId),
    eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, ref.providerLeaseId),
    eq(environmentLeases.status, "released"), eq(environmentLeases.cleanupStatus, "success"),
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    sql`${environmentLeases.metadata}->>'workspaceRecoveryCleanup' is null`));
}
export function retainedWorkspaceCandidates(db: Db, cursor?: string) {
  return db.select({ action: issueRecoveryActions, run: heartbeatRuns }).from(issueRecoveryActions)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId), eq(heartbeatRuns.id,
      sql`case when ${issueRecoveryActions.evidence}->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${issueRecoveryActions.evidence}->>'runId')::uuid end`)))
    .where(and(inArray(heartbeatRuns.status, terminal),
      sql`(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or ${issueRecoveryActions.cause} in ('native_workspace_sync_out_unrecoverable', 'native_workspace_sync_out_retry_exhausted'))`,
      sql`(${issueRecoveryActions.evidence}->'executionReconciliation' is null
        or ${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' = 'recovered')`,
      sql`(coalesce(${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}', '') <> 'blocked' or
        (${issueRecoveryActions.evidence}#>>'{workspaceRecovery,blockerCode}' = 'stop' and exists (
          select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
          and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id} and ${environmentLeases.status} = 'released'
          and ${environmentLeases.id}::text = ${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,leaseId}'
          and ${environmentLeases.cleanupStatus} = 'success' and ${environmentLeases.metadata}->'remoteExecutionTermination'->>'state' = 'stopped')))`,
      sql`(${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' is distinct from 'recovered' or
        (${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,resourceDisposition}' = 'destroy' and exists (
          select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
          and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
          and ${environmentLeases.id}::text = ${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,leaseId}'
          and ${environmentLeases.status} = 'released' and ${environmentLeases.cleanupStatus} = 'success'
          and ${environmentLeases.metadata}->'workspaceRecoveryCleanup' is null)) or exists (
        select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${issueRecoveryActions.companyId}
        and ${agentWakeupRequests.status} = 'deferred_issue_execution' and ${agentWakeupRequests.requestedByActorType} = 'user'
        and ${agentWakeupRequests.payload}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text))`,
      cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
    )).orderBy(asc(issueRecoveryActions.id)).limit(5);
}

/** Bounded discovery shares the periodic recovery lifecycle. A repaired source
 * still owes cleanup even without saved input or after task reconciliation. */
export async function reconcileRetainedWorkspaces(db: Db, runtime: EnvironmentRuntimeService,
  onRecovered: (run: typeof heartbeatRuns.$inferSelect) => Promise<void>) {
  let pending = workInFlight.get(db);
  if (!pending) { pending = new Set(); workInFlight.set(db, pending); }
  if (pending.size >= 2) return;
  let rows = await retainedWorkspaceCandidates(db, cursors.get(db));
  if (!rows.length) rows = await retainedWorkspaceCandidates(db);
  for (const { action, run } of rows) {
    if (pending.size >= 2) break;
    cursors.set(db, action.id);
    if (pending.has(run.id)) continue;
    pending.add(run.id);
    void (async () => { try {
      await recoverRetainedWorkspace({ db, environmentRuntime: runtime, companyId: action.companyId, issueId: action.sourceIssueId, runId: run.id, actionId: action.id });
      const [updated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      if (readWorkspaceRecovery(updated?.evidence ?? null)?.status === "recovered") {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        if (current) { await scheduleRecoveredWorkspaceCleanup(db, current); await onRecovered(current); }
      }
    } catch { logger.warn({ runId: run.id }, "Retained workspace remains pending"); }
    finally { pending.delete(run.id); } })();
  }
}
