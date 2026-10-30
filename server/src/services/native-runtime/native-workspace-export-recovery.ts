import { notifyNativeFinalizationWork } from "../native-finalization-notifications.js";
import { alias } from "drizzle-orm/pg-core";
import { notifyUnsafeWorkspaceExportRecovery, type UnsafeWorkspaceExportScope } from "../unsafe-workspace-export-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, notExists, or, sql } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import { publishLiveEvent } from "../live-events.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";

const UNSAFE_EXPORT = "native_workspace_sync_out_unsafe_archive";
const scanCursors = new WeakMap<Db, string>();

/** Older controllers terminalized unsafe archives. Omit that already-rejected
 * export and replay only the accepted result through the normal status arbiter.
 * No provider access is necessary, even if the old sandbox no longer exists. */
export async function recoverLegacyUnsafeWorkspaceExports(db: Db, runIds?: string[]) {
  const selectCandidates = (cursor?: string) => db.select({ runId: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId, issueId: nativeRunFinalizations.issueId })
    .from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.phase, "terminal_failure"), eq(nativeRunFinalizations.failureCode, UNSAFE_EXPORT),
      ...(runIds?.length ? [inArray(nativeRunFinalizations.runId, runIds)] : []),
      ...(cursor ? [gt(nativeRunFinalizations.runId, cursor)] : []),
    )).orderBy(asc(nativeRunFinalizations.runId)).limit(25);
  let candidates = await selectCandidates(runIds?.length ? undefined : scanCursors.get(db));
  if (!candidates.length && !runIds?.length && scanCursors.has(db)) {
    scanCursors.delete(db);
    candidates = await selectCandidates();
  }
  for (const candidate of candidates) {
    if (!runIds?.length) scanCursors.set(db, candidate.runId);
    await recoverCandidate(db, candidate);
  }
}

async function recoverCandidate(db: Db, candidate: { runId: string; companyId: string; issueId: string }) {
  const owned = await withNativeWorkspaceFinalizationOwnership({ db, ...candidate }, async ownership => {
    await ownership.assertHeld();
    return db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId))).for("update").limit(1);
      const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, candidate.companyId), eq(nativeRunFinalizations.runId, candidate.runId),
      )).for("update").limit(1);
      if (!coordinator || coordinator.phase !== "terminal_failure" || coordinator.failureCode !== UNSAFE_EXPORT
        || !coordinator.resultId || coordinator.leaseOwner || coordinator.issueId !== issue?.id) return null;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, candidate.runId))).for("update").limit(1);
      if (!issue || !run || run.runtimeMode !== "native" || run.nativeIssueId !== issue.id) return null;
      const [result] = await tx.select().from(nativeRunResults).where(and(
        eq(nativeRunResults.id, coordinator.resultId), eq(nativeRunResults.companyId, run.companyId),
        eq(nativeRunResults.runId, run.id), eq(nativeRunResults.issueId, issue.id),
        eq(nativeRunResults.completionContractId, run.completionContractId ?? "00000000-0000-0000-0000-000000000000"),
        eq(nativeRunResults.schemaStatus, "accepted"),
      )).limit(1);
      if (!result) return null;
      const priorActions = await tx.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
        eq(issueRecoveryActions.cause, UNSAFE_EXPORT), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      ));
      const explicitlySettled = priorActions.some(action => action.status === "cancelled"
        || (action.status === "resolved" && !["new_source_execution_path", "unsafe_export_automatic_recovery"].includes(action.resolutionNote ?? "")));
      const now = new Date();


      if (priorActions.some(action => ["active", "escalated"].includes(action.status)
        || (action.status === "resolved" && action.resolutionNote === "new_source_execution_path"))) {

        await notifyUnsafeWorkspaceExportRecovery(tx, { companyId: run.companyId, issueId: issue.id });
      }
      await tx.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: now,
        resolutionNote: "unsafe_export_automatic_recovery", nextAction: "", wakePolicy: null, updatedAt: now,
      }).where(and(eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
        eq(issueRecoveryActions.cause, UNSAFE_EXPORT), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
        or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.resolutionNote, "new_source_execution_path"))),
      ));
      const [newerRun] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
        or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
        or(gt(heartbeatRuns.createdAt, run.createdAt), inArray(heartbeatRuns.status, ["queued", "running"])),
      )).limit(1);
      const [otherAction] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
      )).limit(1);
      const [latestContract] = await tx.select({ id: completionContracts.id }).from(completionContracts).where(and(
        eq(completionContracts.companyId, run.companyId), eq(completionContracts.issueId, issue.id),
      )).orderBy(desc(completionContracts.revision)).limit(1);
      const eligible = !explicitlySettled && !newerRun && !otherAction && latestContract?.id === result.completionContractId
        && ["blocked", "in_review"].includes(issue.status) && issue.assigneeAgentId === run.agentId
        && ["failed", "succeeded"].includes(run.status) && run.nativePhase === "terminal_failure"
        && (!issue.executionRunId || issue.executionRunId === run.id)
        && (!issue.checkoutRunId || issue.checkoutRunId === run.id);
      let updatedRun: typeof heartbeatRuns.$inferSelect | undefined;
      if (eligible) {
        await ownership.assertHeld();
        await notifyNativeFinalizationWork(tx, { companyId: run.companyId, runId: run.id });
        await tx.insert(workspaceOperations).values({ companyId: run.companyId, heartbeatRunId: run.id, issueId: issue.id,
          phase: "workspace_finalize", status: "succeeded", exitCode: 0, finishedAt: now,
          metadata: { owningService: "native_workspace_finalizer", workspaceSync: { omitted: true, reason: "restore_unsafe_archive", legacy: true } },
        });
        await tx.update(nativeRunFinalizations).set({ phase: "result_accepted", failureCode: null, nextAttemptAt: null,
          failureDetail: { workspaceFinalizeAttempt: 0, legacyUnsafeExportOmitted: { resultId: result.id, recoveredAt: now.toISOString() } }, updatedAt: now,
        }).where(eq(nativeRunFinalizations.runId, run.id));
        [updatedRun] = await tx.update(heartbeatRuns).set({ status: "running", finishedAt: null, error: null, errorCode: null,
          nativePhase: "result_accepted", nativePhaseUpdatedAt: now,
          resultJson: { ...run.resultJson, finalizationPhase: "result_accepted", failureCode: null, originalFailureCode: null, nextAttemptAt: null }, updatedAt: now,
        }).where(eq(heartbeatRuns.id, run.id)).returning();
        await tx.update(issues).set({ executionRunId: run.id, updatedAt: now }).where(eq(issues.id, issue.id));
        await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
          eventType: "workspace_export_omitted", stream: "system", level: "info",
          message: "Historical unsafe workspace export omitted; continuing with the accepted result.",
          payload: { reason: "restore_unsafe_archive", legacy: true },
        });
      }


      return updatedRun ?? null;
    });
  });
  if (owned.acquired && owned.value) publishLiveEvent({ companyId: owned.value.companyId,
    type: "heartbeat.run.status", payload: buildHeartbeatRunStatusLiveEventPayload(owned.value),
  });
}

function findOwedUnsafeExports(db: Db, scope?: UnsafeWorkspaceExportScope, after?: string, runId?: string) {
  const action = alias(issueRecoveryActions, "unsafe_export_action");
  const otherRun = alias(heartbeatRuns, "unsafe_export_other_run");
  const contract = alias(completionContracts, "unsafe_export_contract");
  const sameActionRun = and(eq(action.companyId, nativeRunFinalizations.companyId),
    eq(action.sourceIssueId, nativeRunFinalizations.issueId), eq(action.cause, UNSAFE_EXPORT),
    sql`${action.evidence}->>'runId' = ${nativeRunFinalizations.runId}::text`);
  const staleAction = db.select({ id: action.id }).from(action).where(and(sameActionRun,
    or(inArray(action.status, ["active", "escalated"]),
      and(eq(action.status, "resolved"), eq(action.resolutionNote, "new_source_execution_path")))));
  const explicitlySettled = db.select({ id: action.id }).from(action).where(and(sameActionRun,
    or(eq(action.status, "cancelled"), and(eq(action.status, "resolved"),
      sql`coalesce(${action.resolutionNote}, '') not in ('new_source_execution_path', 'unsafe_export_automatic_recovery')`))));
  const competingAction = db.select({ id: action.id }).from(action).where(and(
    eq(action.companyId, nativeRunFinalizations.companyId), eq(action.sourceIssueId, nativeRunFinalizations.issueId),
    inArray(action.status, ["active", "escalated"]),
    or(ne(action.cause, UNSAFE_EXPORT), sql`${action.evidence}->>'runId' is distinct from ${nativeRunFinalizations.runId}::text`)));
  const newerRun = db.select({ id: otherRun.id }).from(otherRun).where(and(
    eq(otherRun.companyId, heartbeatRuns.companyId), ne(otherRun.id, heartbeatRuns.id),
    or(eq(otherRun.nativeIssueId, issues.id), sql`${otherRun.contextSnapshot}->>'issueId' = ${issues.id}::text`),
    or(gt(otherRun.createdAt, heartbeatRuns.createdAt), inArray(otherRun.status, ["queued", "running"]))));
  const latestContract = db.select({ id: contract.id }).from(contract).where(and(
    eq(contract.companyId, nativeRunFinalizations.companyId), eq(contract.issueId, nativeRunFinalizations.issueId),
  )).orderBy(desc(contract.revision)).limit(1);
  return db.select({ runId: nativeRunFinalizations.runId, companyId: nativeRunFinalizations.companyId, issueId: nativeRunFinalizations.issueId })
    .from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId),
      eq(heartbeatRuns.id, nativeRunFinalizations.runId), eq(heartbeatRuns.nativeIssueId, nativeRunFinalizations.issueId)))
    .innerJoin(issues, and(eq(issues.companyId, nativeRunFinalizations.companyId), eq(issues.id, nativeRunFinalizations.issueId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.companyId, heartbeatRuns.companyId), eq(nativeRunResults.runId, heartbeatRuns.id),
      eq(nativeRunResults.issueId, issues.id), eq(nativeRunResults.completionContractId, heartbeatRuns.completionContractId),
      eq(nativeRunResults.schemaStatus, "accepted")))
    .where(and(eq(nativeRunFinalizations.phase, "terminal_failure"), eq(nativeRunFinalizations.failureCode, UNSAFE_EXPORT),
      eq(heartbeatRuns.runtimeMode, "native"),
      scope ? and(eq(nativeRunFinalizations.companyId, scope.companyId), scope.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined) : undefined,
      after ? gt(nativeRunFinalizations.runId, after) : undefined,
      runId ? eq(nativeRunFinalizations.runId, runId) : undefined,
      or(exists(staleAction), and(
        notExists(explicitlySettled), notExists(competingAction), notExists(newerRun),
        eq(nativeRunResults.completionContractId, latestContract),
        inArray(issues.status, ["blocked", "in_review"]), eq(issues.assigneeAgentId, heartbeatRuns.agentId),
        inArray(heartbeatRuns.status, ["failed", "succeeded"]), eq(heartbeatRuns.nativePhase, "terminal_failure"),
        or(isNull(issues.executionRunId), eq(issues.executionRunId, heartbeatRuns.id)),
        or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, heartbeatRuns.id)),
      )),
    )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
}

export function registerUnsafeWorkspaceExportWork(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
  type Entry = UnsafeWorkspaceExportScope & { id: string; dueAt: number };
  async function load(scope?: UnsafeWorkspaceExportScope, signal?: AbortSignal): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await findOwedUnsafeExports(db, scope, after);
      for (const row of rows) entries.push({ id: row.runId, companyId: row.companyId, issueId: row.issueId, dueAt: 0 });
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].runId;
    }
    throw new Error("Unsafe export recovery discovery stopped");
  }
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.unsafeWorkspaceExportRecovery, batchSize: 5,
    decodeScope: (hint: string): UnsafeWorkspaceExportScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry: Entry, scope?: UnsafeWorkspaceExportScope) => !scope || entry.companyId === scope.companyId && (!scope.issueId || entry.issueId === scope.issueId),
    load,
    check: async (entry: Entry, signal?: AbortSignal) => {
      const [candidate] = await findOwedUnsafeExports(db, entry, undefined, entry.id);
      if (!canRun() || signal?.aborted) throw new Error("Unsafe export recovery stopped");
      if (!candidate) return null;
      await recoverCandidate(db, candidate);
      const pending = await findOwedUnsafeExports(db, entry, undefined, entry.id);
      return pending.length ? { ...entry, dueAt: Date.now() + 30_000 } : null;
    },
  }, canRun);
}
