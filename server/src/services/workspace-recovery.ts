import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { beginIdleTrackedWork } from "./task-admission.js";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import { and, asc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { hasStopOnlyCleanup, prepareHistoricalSandboxStopVerification, prepareSandboxStopAndRetain, prepareStoppedSandboxForRecovery, settleAbsentSandbox, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { requestSandboxAbsenceProof } from "./sandbox-absence-proof.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery, type WorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-runtime/native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference, readNativeWorkspaceSyncLocalCwd, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { classifyNativeWorkspaceFailure } from "./native-runtime/native-workspace-failure.js";

import { adoptSystemRecovery, loadSystemRecovery, updateSystemRecovery } from "./system-recovery.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure, type SystemRecoveryState } from "./system-recovery-state.js";
import { inspectWorkspaceRecoverySource, workspaceRecoverySourceEligible } from "./workspace-recovery-source.js";
import { preserveWorkspaceSnapshot } from "./workspace-recovery-snapshot.js";
import { adoptHistoricalWorkspaceRecoveries } from "./workspace-recovery-backfill.js";

const exportCauses = ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"];
const terminal = ["failed", "interrupted", "timed_out", "cancelled", "succeeded"];
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
    const pending = prior && ["queued", "recovering"].includes(prior.status);
    const state: WorkspaceRecovery = pending ? { ...prior!, requestIds: [...prior!.requestIds, input.idempotencyKey] }
      : { schema: "paperclip.workspace-recovery.v1", runId: run.id, status: "queued", stage: "verifying_stop",
        attempt: prior?.attempt ?? 0, attemptLimit: (prior?.attempt ?? 0) + 1,
        requestIds: [...(prior?.requestIds ?? []), input.idempotencyKey] };
    const previous = readSystemRecovery(action.evidence);
    const active = previous && ["scheduled", "running", "awaiting_evidence"].includes(previous.state);
    const system = previous?.state === "running" ? previous : active ? { ...previous, revision: previous.revision + 1,
      nextAttemptAt: Math.max(Date.now(), previous.providerCooldownAt ?? 0) } : { ...createSystemRecovery(run.id),
      revision: (previous?.revision ?? -1) + 1,
      preservationOperationIds: previous?.preservationOperationIds ?? [],
      providerCooldownAt: previous?.providerCooldownAt ?? null,
      nextAttemptAt: previous?.providerCooldownAt ?? null };
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    await tx.update(issueRecoveryActions).set({ ownerType: "system", ownerAgentId: null, ownerUserId: null,
      evidence: { ...action.evidence, workspaceRecovery: state, systemRecovery: system }, updatedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action.id));
    await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "user", actorId: input.actorId,
      action: "issue.workspace_recovery_requested", entityType: "issue", entityId: issue.id, runId: run.id,
      details: { recoveryActionId: action.id, idempotencyKey: input.idempotencyKey,
        ...(previous && previous.generationId !== system.generationId ? { previousGeneration: previous } : {}) } });
    return { actionId: action.id, status: state.status };
  });
}

/** Physical repair remains serialized by the existing source ownership lock.
 * Neither preservation nor cleanup creates an agent turn. */
export async function recoverRetainedWorkspace(input: Source & { db: Db; environmentRuntime: EnvironmentRuntimeService }) {
  const { db } = input;
  await adoptSystemRecovery(db, input);
  const initial = await loadSystemRecovery(db, input);
  if (!initial || initial.state === "complete" || initial.state === "exhausted" ||
      (initial.nextAttemptAt !== null && initial.nextAttemptAt > Date.now())) return;
  const runAttempt = async (ownership: { token: string; assertHeld(): Promise<void> }) => {
    let current = await loadSystemRecovery(db, input);
    if (!current) return;
    const reserved = reserveSystemRecoveryAttempt(current);
    if (!reserved) {
      if (current.state !== "exhausted" && current.deadlineAt !== null && Date.now() >= current.deadlineAt)
        await updateSystemRecovery(db, input, current, { ...current, revision: current.revision + 1,
          state: "exhausted", nextAttemptAt: null });
      return;
    }
    if (!await updateSystemRecovery(db, input, current, reserved)) return;
    current = reserved;
    const progress = async (patch: Partial<SystemRecoveryState>) => {
      await ownership.assertHeld();
      const next = { ...current!, ...patch, revision: current!.revision + 1 };
      if (!await updateSystemRecovery(db, input, current!, next)) throw new Error("workspace_recovery_generation_changed");
      current = next;
    };
    const observeActive = async () => {
      await ownership.assertHeld();
      await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
        '{systemRecoveryActiveAt}', ${JSON.stringify(Date.now())}::jsonb)` }).where(and(
          eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.actionId),
          sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,attemptId}' = ${reserved.attemptId}`));
    };
    let observing = Promise.resolve();
    const observer = setInterval(() => { observing = observing.then(observeActive).catch(() => undefined); }, 15_000);
    try {
      await observeActive();
      const inspected = await inspectWorkspaceRecoverySource(db, input);
      let sourceUnavailable = false;
      for (const source of inspected.sources) {
        const { lease, environment, remoteCwd } = source;
        if (hasRemoteTerminationReceipt(lease)
          && (lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined)?.state === "destroyed") {
          sourceUnavailable = true;
          continue;
        }
        if (lease.provider === "daytona" && lease.providerLeaseId) {
          const absence = await requestSandboxAbsenceProof({ companyId: input.companyId, issueId: input.issueId, runId: input.runId, leaseId: lease.id,
            provider: "daytona", providerLeaseId: lease.providerLeaseId, ownerToken: ownership.token });
          if (absence) {
            await ownership.assertHeld();
            if (!await settleAbsentSandbox(db, lease, absence)) throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
            sourceUnavailable = true;
            continue;
          }
        }
        let reference = source.reference;
        if (reference) {
          try { await readNativeWorkspaceSyncLocalCwd({ runId: input.runId, companyId: input.companyId,
            workspaceId: reference.workspaceId, reference }); }
          catch (error) {
            // Missing local merge metadata permits a separate snapshot of the
            // exact bound allocation. Corrupt metadata never weakens binding.
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") reference = null;
            else throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
          }
        }
        let stoppedLease = lease;
        if (!hasRemoteTerminationReceipt(stoppedLease)) {
          const pending = await db.transaction(async tx => {
            const [fresh] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
              eq(environmentLeases.id, lease.id))).for("update");
            if (!fresh || fresh.metadata?.pendingCleanupInFlight === true) return null;
            const prepared = hasStopOnlyCleanup(fresh) ? fresh : fresh.status === "released"
              ? await prepareHistoricalSandboxStopVerification(tx as unknown as Db, fresh)
              : await prepareSandboxStopAndRetain(tx as unknown as Db, fresh);
            if (!prepared) return null;
            const [claimed] = await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} ||
              ${JSON.stringify({ pendingCleanupAttemptId: ownership.token, pendingCleanupInFlight: true,
                pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000 })}::jsonb` })
              .where(eq(environmentLeases.id, lease.id)).returning();
            return claimed;
          });
          if (!pending) throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
          // The cleanup service owns exact-allocation termination. No process ID
          // or terminal run status is substituted for its provider receipt.
          const receipt = await input.environmentRuntime.retryPendingSandboxTeardown({
            environment: environment as unknown as Environment, lease: pending as EnvironmentLease }).catch(async () => {
              await settleStopOnlyCleanup(db, pending, { attemptId: ownership.token });
              throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
            });
          const settled = await settleStopOnlyCleanup(db, pending, { attemptId: ownership.token, receipt });
          if (!settled || !hasRemoteTerminationReceipt(settled))
            throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
          stoppedLease = settled;
        }
        const target = await resolveEnvironmentExecutionTarget({ db, companyId: input.companyId, adapterType: "paperclip_runner",
          environment, leaseId: lease.id, leaseMetadata: stoppedLease.metadata,
          lease: stoppedLease as EnvironmentLease, environmentRuntime: input.environmentRuntime });
        if (target?.kind !== "remote" || target.transport !== "sandbox" || !target.runner || target.remoteCwd !== remoteCwd)
          throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
        await ownership.assertHeld();
        const cleanupLease = await db.transaction(async tx => {
          const [fresh] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
            eq(environmentLeases.id, lease.id))).for("update");
          if (!fresh || !hasRemoteTerminationReceipt(fresh) || fresh.providerLeaseId !== lease.providerLeaseId)
            throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
          const pending = await prepareStoppedSandboxForRecovery(tx as unknown as Db, fresh);
          if (!pending) throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
          const [claimed] = await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({
            pendingCleanupAttemptId: ownership.token, pendingCleanupInFlight: true, pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000,
          })}::jsonb` }).where(eq(environmentLeases.id, fresh.id)).returning();
          return claimed;
        });
        let renewal = Promise.resolve();
        const keepalive = setInterval(() => { renewal = renewal.then(async () => {
          await ownership.assertHeld();
          await db.update(environmentLeases).set({ metadata: sql`jsonb_set(${environmentLeases.metadata}, '{pendingCleanupLeaseExpiresAtMs}', ${JSON.stringify(Date.now() + 15 * 60_000)}::jsonb)` })
            .where(and(eq(environmentLeases.id, lease.id), sql`${environmentLeases.metadata}->>'pendingCleanupAttemptId' = ${ownership.token}`));
        }).catch(() => undefined); }, 30_000);
        let stopSettled = false;
        try {
          const opened = await input.environmentRuntime.resumeWorkspaceRecoveryLease({ source: input,
            leaseId: cleanupLease.id, environmentId: environment.id, ownership });
          if (opened?.providerLeaseId !== lease.providerLeaseId || opened.metadata?.remoteCwd !== remoteCwd)
            throw new SystemRecoveryFailure("source_binding_invalid", "service_required");
          await inspectWorkspaceRecoverySource(db, input);
          await progress({ phase: "preserve_files" });
          let operationId: string;
          if (reference) {
            const copied = await resumeNativeWorkspaceSync({ db, runId: input.runId, target, assertOwnership: ownership.assertHeld });
            if (!copied) throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
            const after = await inspectWorkspaceRecoverySource(db, input);
            const finalized = after.sources.find(item => item.lease.id === lease.id)?.reference;
            if (finalized?.state !== "finalized" || !finalized.finalHostSha256)
              throw new SystemRecoveryFailure("snapshot_verification_failed", "service_required");
            await ownership.assertHeld();
            const [existing] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
              eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.heartbeatRunId, input.runId),
              eq(workspaceOperations.phase, "workspace_recovery"), eq(workspaceOperations.status, "succeeded"),
              sql`${workspaceOperations.metadata}->>'leaseId' = ${lease.id}`)).limit(1);
            const copy = existing ?? (await db.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
              heartbeatRunId: input.runId, executionWorkspaceId: lease.executionWorkspaceId, phase: "workspace_recovery",
              status: "succeeded", finishedAt: new Date(), metadata: { recoveryActionId: input.actionId, leaseId: lease.id,
                providerLeaseId: lease.providerLeaseId, descriptorSha256: finalized.descriptorSha256,
                finalHostSha256: finalized.finalHostSha256 } }).returning({ id: workspaceOperations.id }))[0];
            operationId = copy.id;
          } else {
            operationId = await preserveWorkspaceSnapshot({ ...input, leaseId: lease.id,
              providerLeaseId: lease.providerLeaseId!, target, assertHeld: ownership.assertHeld });
          }
          await progress({ preservationOperationIds: [...new Set([...current!.preservationOperationIds, operationId])] });
          clearInterval(keepalive); await renewal;
          await ownership.assertHeld();
          const receipt = await input.environmentRuntime.retryPendingSandboxTeardown({ environment: environment as unknown as Environment,
            lease: cleanupLease as EnvironmentLease });
          const settled = await settleStopOnlyCleanup(db, cleanupLease, { attemptId: ownership.token, receipt });
          stopSettled = Boolean(settled && hasRemoteTerminationReceipt(settled));
          if (!stopSettled) throw new SystemRecoveryFailure("agent_stop_unconfirmed", "recheck_evidence");
        } finally {
          clearInterval(keepalive); await renewal;
          if (!stopSettled) {
            // A lost resume/export reply retains the same stop-only obligation.
            // The maintenance worker must never turn it into destructive cleanup.
            try {
              await ownership.assertHeld();
              const receipt = await input.environmentRuntime.retryPendingSandboxTeardown({ environment: environment as unknown as Environment,
                lease: cleanupLease as EnvironmentLease });
              await settleStopOnlyCleanup(db, cleanupLease, { attemptId: ownership.token, receipt });
            } catch { /* The persisted stop-only obligation remains authoritative. */ }
          }
        }
      }
      await ownership.assertHeld();
      if (sourceUnavailable) throw new SystemRecoveryFailure("source_unavailable", "use_alternative_strategy");
      const next = { ...current!, revision: current!.revision + 1, phase: "reconcile_effects" as const,
        state: "complete" as const, nextAttemptAt: null };
      const activity = await db.transaction(async tx => {
        await tx.insert(workspaceOperations).values({ companyId: input.companyId, issueId: input.issueId,
          heartbeatRunId: input.runId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date(),
          metadata: { owningService: "workspace_recovery", preservationOperationIds: next.preservationOperationIds } });
        if (!await updateSystemRecovery(tx as unknown as Db, input, current!, next))
          throw new Error("workspace_recovery_generation_changed");
        return persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "workspace-recovery",
          action: "issue.workspace_recovered", entityType: "issue", entityId: input.issueId, runId: input.runId,
          details: { recoveryActionId: input.actionId, summary: "Saved work recovered." } });
      });
      current = next;
      try { publishActivity(activity.publication); } catch { logger.warn({ runId: input.runId }, "Recovery activity delivery deferred"); }
    } catch (error) {
      await ownership.assertHeld();
      if (current!.state === "complete") {
        logger.warn({ runId: input.runId }, "Preserved workspace activity delivery deferred");
        return;
      }
      const classification = classifyNativeWorkspaceFailure(error);
      const failure = error instanceof SystemRecoveryFailure ? error
        : classification.code === "workspace_sync_out_unsafe_archive"
          ? new SystemRecoveryFailure("archive_unsafe", "service_required")
          : classification.code === "workspace_sync_out_unrecoverable"
            ? new SystemRecoveryFailure("source_unavailable", "use_alternative_strategy")
            : new SystemRecoveryFailure(current!.phase === "verify_execution" ? "provider_unavailable" : "export_interrupted", "retry_transient");
      const retryAfterAt = (error as { retryAfterAt?: unknown })?.retryAfterAt;
      await updateSystemRecovery(db, input, current!, failSystemRecovery(current!, failure, {
        ...(typeof retryAfterAt === "number" && Number.isFinite(retryAfterAt) ? { retryAfterAt } : {}),
      }));
      logger.warn({ err: error, runId: input.runId, failureCode: failure.code, phase: current!.phase }, "Workspace preservation deferred; source retained");
    } finally { clearInterval(observer); await observing; }
  };
  const owned = await withNativeWorkspaceFinalizationOwnership({ db, companyId: input.companyId, runId: input.runId,
    retainedRepairActionId: input.actionId }, runAttempt);
  if (!owned.acquired && owned.reason === "owner_unverified") {
    const current = await loadSystemRecovery(db, input);
    const reserved = current && reserveSystemRecoveryAttempt(current);
    if (current && reserved) await updateSystemRecovery(db, input, current,
      failSystemRecovery(reserved, new SystemRecoveryFailure("copyback_stop_unconfirmed", "recheck_evidence")));
  }
}

const cursors = new WeakMap<Db, string>();
const workInFlight = new WeakMap<Db, Set<string>>();
const unfinishedCursors = new WeakMap<Db, string>();

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
  await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "ephemeral",
    updatedAt: new Date(), metadata: sql`(${environmentLeases.metadata} - 'workspaceRestoreRecovery' - 'remoteExecutionTermination') ||
      ${JSON.stringify({ workspaceRecoveryCleanup: { runId: run.id, descriptorSha256: ref.descriptorSha256 },
        pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0, pendingCleanupLeaseExpiresAtMs: 0 })}::jsonb`,
  }).where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, ref.leaseId),
    eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, ref.providerLeaseId),
    eq(environmentLeases.status, "released"), eq(environmentLeases.cleanupStatus, "success"),
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    sql`${environmentLeases.metadata}->>'workspaceRecoveryCleanup' is null`)));
}
export function retainedWorkspaceCandidates(db: Db, cursor?: string, unfinishedOnly = false, obligationsOnly = false) {
  const cleanup = sql`(${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,resourceDisposition}' = 'destroy' and exists (
    select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${heartbeatRuns.companyId}
    and ${environmentLeases.heartbeatRunId} = ${heartbeatRuns.id}
    and ${environmentLeases.id}::text = ${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,leaseId}'
    and ${environmentLeases.status} = 'released' and ${environmentLeases.cleanupStatus} = 'success'
    and ${environmentLeases.metadata}->'workspaceRecoveryCleanup' is null))`;
  const waitingInput = sql`exists (select 1 from ${agentWakeupRequests}
    where ${agentWakeupRequests.companyId} = ${issueRecoveryActions.companyId}
    and ${agentWakeupRequests.status} = 'deferred_issue_execution' and ${agentWakeupRequests.requestedByActorType} = 'user'
    and ${agentWakeupRequests.payload}->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text)`;
  return db.select({ action: issueRecoveryActions, run: heartbeatRuns }).from(issueRecoveryActions)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId), eq(heartbeatRuns.id,
      sql`case when ${issueRecoveryActions.evidence}->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${issueRecoveryActions.evidence}->>'runId')::uuid end`)))
    .where(and(inArray(heartbeatRuns.status, terminal),
      workspaceRecoverySourceEligible(true),
      unfinishedOnly ? sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')` : undefined,
      obligationsOnly ? sql`(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')
        or (${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete' and ${cleanup}) or ${waitingInput})` : undefined,
      sql`(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence', 'complete', 'exhausted')
        and (${issueRecoveryActions.evidence}#>'{systemRecovery,nextAttemptAt}' = 'null'::jsonb
          or ${issueRecoveryActions.evidence}#>'{systemRecovery,nextAttemptAt}' <= to_jsonb(${Date.now()}::bigint)))`,
      sql`(${issueRecoveryActions.evidence}#>>'{workspaceRecovery,status}' is distinct from 'recovered' or
        ${cleanup} or ${waitingInput})`,
      cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
    )).orderBy(asc(issueRecoveryActions.id)).limit(5);
}

/** Bounded discovery shares the periodic recovery lifecycle. A repaired source
 * still owes cleanup even without saved input or after task reconciliation. */
export async function reconcileRetainedWorkspaces(db: Db, runtime: EnvironmentRuntimeService,
  onRecovered: (run: typeof heartbeatRuns.$inferSelect) => Promise<void>, obligationsOnly = false,
  onFinished?: (continueSweep: boolean) => void, passiveSweep?: { cursor?: string }) {
  await adoptHistoricalWorkspaceRecoveries(db);
  let pending = workInFlight.get(db);
  if (!pending) { pending = new Set(); workInFlight.set(db, pending); }
  if (pending.size >= 2) return;
  let rows = await retainedWorkspaceCandidates(db, unfinishedCursors.get(db), true);
  if (!rows.length) rows = await retainedWorkspaceCandidates(db, undefined, true);
  const unfinished = rows.length > 0;
  if (!rows.length) rows = await retainedWorkspaceCandidates(db, passiveSweep ? passiveSweep.cursor : cursors.get(db), false, obligationsOnly);
  if (!rows.length && !passiveSweep) rows = await retainedWorkspaceCandidates(db, undefined, false, obligationsOnly);
  const work: Promise<void>[] = [];
  let hasUnvisited = false;
  for (const { action, run } of rows) {
    if (pending.size >= 2) { hasUnvisited = true; break; }
    if (unfinished) unfinishedCursors.set(db, action.id);
    else if (passiveSweep) passiveSweep.cursor = action.id;
    else cursors.set(db, action.id);
    if (pending.has(run.id)) continue;
    pending.add(run.id);
    const finish = beginIdleTrackedWork();
    const physical = ["scheduled", "running", "awaiting_evidence"].includes(readSystemRecovery(action.evidence)?.state ?? "");
    work.push((async () => { try {
      await recoverRetainedWorkspace({ db, environmentRuntime: runtime, companyId: action.companyId, issueId: action.sourceIssueId, runId: run.id, actionId: action.id });
      const [updated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const recovered = readWorkspaceRecovery(updated?.evidence ?? null)?.status === "recovered";
      const exhausted = readSystemRecovery(updated?.evidence)?.state === "exhausted";
      if (recovered || exhausted) {
        const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        if (current) {
          if (recovered) {
            await resumePreservedResultFinalization(db, current.companyId, current.id);
            await scheduleRecoveredWorkspaceCleanup(db, current);
          }
          // Only normal dispatch can consume existing authorized input. An
          // exhausted export permits evaluation of an isolated continuation,
          // never another export attempt or a replay of an old assignment.
          await onRecovered(current);
        }
      }
    } catch { logger.warn({ runId: run.id }, "Retained workspace remains pending"); }
    finally { pending.delete(run.id); finish(); onFinished?.(physical || hasUnvisited); } })());
  }
  return work;
}
