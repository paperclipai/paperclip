import { lstat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { caseEvents, caseHandoffs, cases, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { persistActivity, type ActivityPublication } from "../activity-log.js";
import { conflict } from "../../errors.js";
import { getExecutionBlocker, hasPendingRunCleanup } from "../execution-blocker.js";
import { isNativeRunnerOwnershipHeld } from "../native-runtime/native-runner-ownership.js";
import { hasNativeLocalProcessStop } from "../native-local-process-stop.js";
import { remoteExecutionHasStopped } from "../remote-execution-termination.js";
import { hasLegacyExecutionSettlement } from "../legacy-execution-settlement.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { assertActorCanReadCase, assertCaseTrustedForExecution } from "../case-access.js";
import { assertCaseHandoffSourceAuthority, lockCaseHandoffAuthorityRun } from "../case-handoff-authority.js";
import type { AuthorizationActor } from "../authorization.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { cleanupHeartbeatRunScratch, type HeartbeatRunScratch } from "../run-scratch.js";

const LEGACY_HANDOFF_CLEANUP_VERIFIED = "legacy.case_handoff_cleanup_verified";
const LEGACY_HANDOFF_CLEANUP_SCHEMA = "paperclip.legacy-case-handoff-cleanup.v1";
const LEGACY_HANDOFF_CLEANUP_INTENT = "legacy.case_handoff_cleanup_intent";

function localProcessAbsent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Host-owned cleanup intent precedes provider dispatch; it claims no stop. */
export async function recordLegacyCaseHandoffCleanupIntent(db: Db, input: {
  runId: string; issueId: string; controllerBootId: string; scratch: HeartbeatRunScratch | null;
}) {
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
    if (!run || run.runtimeMode !== "legacy" || run.status !== "running" || run.controllerBootId !== input.controllerBootId) return;
    if (input.scratch && (input.scratch.metadata.companyId !== run.companyId || input.scratch.metadata.agentId !== run.agentId ||
      input.scratch.metadata.runId !== run.id || input.scratch.metadata.issueId !== input.issueId)) return;
    await appendHeartbeatRunEvent(tx, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: LEGACY_HANDOFF_CLEANUP_INTENT, stream: "system", level: "info",
      message: "Recorded owned local cleanup before legacy provider dispatch.", payload: {
        schema: "paperclip.legacy-case-handoff-cleanup-intent.v1", issueId: input.issueId, host: hostname(),
        controllerBootId: run.controllerBootId, runStartedAt: run.startedAt?.toISOString() ?? null, scratch: input.scratch,
        processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt?.toISOString() ?? null,
      } });
  });
}

/** Called by scratch cleanup before irreversible removal, never by an adapter. */
export async function recordLegacyCaseHandoffCleanupVerified(db: Db, input: {
  runId: string; controllerBootId: string; scratch: HeartbeatRunScratch;
}) {
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
    if (!run || run.runtimeMode !== "legacy" || run.controllerBootId !== input.controllerBootId ||
        !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status) ||
        !run.processPid || !Number.isSafeInteger(run.processPid) || run.processPid <= 1 ||
        !run.processGroupId || !Number.isSafeInteger(run.processGroupId) || run.processGroupId <= 1 ||
        !localProcessAbsent(run.processPid) || !localProcessAbsent(-run.processGroupId)) return;
    const handoff = await pendingCaseHandoffForRun(tx, run.id, run.companyId);
    const metadata = input.scratch.metadata;
    if (!handoff || metadata.companyId !== run.companyId || metadata.agentId !== run.agentId ||
        metadata.runId !== run.id || metadata.issueId !== handoff.issueId) return;
    const leases = await tx.select({ provider: environmentLeases.provider }).from(environmentLeases)
      .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
    // Remote PID numbers have no meaning on this host.
    if (leases.some(lease => lease.provider !== "local")) return;
    await appendHeartbeatRunEvent(tx, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: LEGACY_HANDOFF_CLEANUP_VERIFIED, stream: "system", level: "info",
      message: "Verified the owned legacy process stopped before scratch removal.", payload: {
        schema: LEGACY_HANDOFF_CLEANUP_SCHEMA, issueId: handoff.issueId, host: hostname(),
        controllerBootId: run.controllerBootId, processPid: run.processPid, processGroupId: run.processGroupId,
        processStartedAt: run.processStartedAt?.toISOString() ?? null, scratch: input.scratch,
      } });
  });
}

async function recoverLegacyCaseHandoffCleanup(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  if (run.runtimeMode !== "legacy" || (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) return false;
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.agentId, run.agentId), inArray(heartbeatRunEvents.eventType, [LEGACY_HANDOFF_CLEANUP_VERIFIED, LEGACY_HANDOFF_CLEANUP_INTENT]),
    eq(heartbeatRunEvents.stream, "system"), isNull(heartbeatRunEvents.sourceEventId),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const receipt = event?.payload;
  const intent = event?.eventType === LEGACY_HANDOFF_CLEANUP_INTENT;
  const scratch = receipt?.scratch as HeartbeatRunScratch | null | undefined;
  if (receipt?.schema !== (intent ? "paperclip.legacy-case-handoff-cleanup-intent.v1" : LEGACY_HANDOFF_CLEANUP_SCHEMA) ||
      receipt.host !== hostname() || receipt.issueId !== issueId ||
      !run.controllerBootId || receipt.controllerBootId !== run.controllerBootId ||
      !run.processPid || !Number.isSafeInteger(run.processPid) || run.processPid <= 1 ||
      !run.processGroupId || !Number.isSafeInteger(run.processGroupId) || run.processGroupId <= 1 ||
      receipt.processPid !== run.processPid || receipt.processGroupId !== run.processGroupId ||
      receipt.processStartedAt !== (run.processStartedAt?.toISOString() ?? null)) return false;
  if (intent) {
    if (receipt.runStartedAt !== (run.startedAt?.toISOString() ?? null) ||
        !localProcessAbsent(run.processPid) || !localProcessAbsent(-run.processGroupId)) return false;
    const leases = await db.select({ provider: environmentLeases.provider }).from(environmentLeases)
      .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
    if (leases.some(lease => lease.provider !== "local")) return false;
    if (scratch === null) return true;
  }
  if (typeof scratch?.dir !== "string" || scratch.metadata?.companyId !== run.companyId ||
      scratch.metadata.agentId !== run.agentId || scratch.metadata.runId !== run.id || scratch.metadata.issueId !== issueId) return false;
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(scratch.dir));
  if (relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(scratch.dir).startsWith("paperclip-run-")) return false;
  try { await lstat(scratch.dir); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
  // A crash immediately before removal can safely retry the same marked
  // directory. A live/reused process group or changed ownership stays held.
  const result = await cleanupHeartbeatRunScratch({ scratch, processGroupId: run.processGroupId,
    isProcessGroupAlive: group => !localProcessAbsent(-group!) });
  return result.removed;
}

/** Kept independent of the handoff application service to avoid an issues/service cycle. */
export async function pendingCaseHandoffForRun(db: Db, runId: string, companyId?: string) {
  const scope = companyId ?? await db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId)).limit(1).then(rows => rows[0]?.companyId);
  if (!scope) return null;
  return db.select().from(caseHandoffs).where(and(eq(caseHandoffs.companyId, scope), eq(caseHandoffs.sourceRunId, runId),
    eq(caseHandoffs.destinationKind, "agent"),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "delivered"])))
    .orderBy(caseHandoffs.createdAt).limit(1).then(rows => rows[0] ?? null);
}

export async function assertNoCaseHandoffMutation(db: Db, runId: string, issueId: string) {
  const handoff = await pendingCaseHandoffForRun(db, runId);
  if (handoff?.issueId === issueId) throw conflict("This run handed off the task. End the turn; the task remains open.",
    { code: "case_handoff_run_yielded", handoffId: handoff.id });
}

/** Called under the task lock by superseding mutations. No issueService dependency. */
export async function cancelCaseHandoffsForIssue(db: Db, input: {
  companyId: string; issueId: string; reason: string; exceptId?: string; publications?: ActivityPublication[];
  /** Run-scoped Stop must not supersede a later phase on the same task. */
  sourceRunId?: string;
  /** Only a Stop that has fenced the task's current execution may revoke a
   * terminal intent accepted without a source run, including an idle board request. */
  includeUnboundTerminalIntent?: boolean;
  /** Accepted completion settles its terminal intent instead of superseding it. */
  agentTransfersOnly?: boolean;
}) {
  const rows = await db.update(caseHandoffs).set({ state: "cancelled", cancelledAt: new Date(), updatedAt: new Date(),
    leaseExpiresAt: null, lastErrorCode: "superseded", lastError: input.reason }).where(and(
    eq(caseHandoffs.companyId, input.companyId), eq(caseHandoffs.issueId, input.issueId),
    input.sourceRunId !== undefined ? or(eq(caseHandoffs.sourceRunId, input.sourceRunId),
      input.includeUnboundTerminalIntent ? and(isNull(caseHandoffs.sourceRunId), eq(caseHandoffs.destinationKind, "done"),
        eq(caseHandoffs.state, "awaiting_completion")) : undefined) : undefined,
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "awaiting_completion"]),
    input.agentTransfersOnly ? eq(caseHandoffs.destinationKind, "agent") : undefined,
    input.exceptId ? sql`${caseHandoffs.id} <> ${input.exceptId}` : undefined,
  )).returning();
  for (const row of rows) {
    await db.insert(caseEvents).values({ companyId: row.companyId, caseId: row.caseId, kind: "handoff_cancelled", actorType: "system",
      runId: row.sourceRunId, payload: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, reason: input.reason, workflowTransition: row.workflowTransition } });
    const event = await persistActivity(db, { companyId: row.companyId, actorType: "system", actorId: "case-handoff",
      runId: row.sourceRunId, issueId: row.issueId, action: "case.handoff_cancelled", entityType: "case", entityId: row.caseId,
      details: { handoffId: row.id, issueId: row.issueId, phase: row.phase, version: row.version, reason: input.reason, workflowTransition: row.workflowTransition } });
    input.publications?.push(event.publication);
  }
  if (rows.length) await notifyDeliveryWork(db, DELIVERY_QUEUES.caseHandoffs, input.companyId);
}

/**
 * The caller holds the task lock in its transaction. This records the consequence
 * of an already accepted Done; it neither decides completion nor bypasses its
 * review/evidence gates. Task, case, intent and audit commit or roll back together.
 */
export async function completeTerminalCaseHandoffsForIssue(db: Db, input: {
  companyId: string; issueId: string; publications?: ActivityPublication[];
}): Promise<number> {
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue || issue.status !== "done") return 0;
  const [snapshot] = await db.select().from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, input.companyId), eq(caseHandoffs.issueId, issue.id),
    eq(caseHandoffs.destinationKind, "done"), eq(caseHandoffs.state, "awaiting_completion"),
  )).limit(1);
  if (!snapshot) return 0;
  // Keep the same task -> source run -> case -> handoff order as handoff
  // acceptance/dispatch. Status-version changes during review are legitimate;
  // assignment changes cancel this intent at the common task mutation boundary.
  await lockCaseHandoffAuthorityRun(db, snapshot, issue);
  const [caseRow] = await db.select().from(cases).where(and(eq(cases.id, snapshot.caseId), eq(cases.companyId, input.companyId))).for("update");
  const [row] = await db.select().from(caseHandoffs).where(and(eq(caseHandoffs.id, snapshot.id),
    eq(caseHandoffs.state, "awaiting_completion"), eq(caseHandoffs.destinationKind, "done"))).for("update");
  if (!row) return 0;
  let invalidReason: string | null = null;
  if (!caseRow || caseRow.workIssueId !== issue.id || caseRow.handoffVersion !== row.version ||
      issue.assigneeAgentId !== row.fromAgentId || issue.assigneeUserId || issue.responsibleUserId !== row.responsibleUserId ||
      caseRow.status === "cancelled") {
    invalidReason = "Terminal handoff was superseded by a newer task or case decision";
  } else {
    try {
      const authorizingUserId = await assertCaseHandoffSourceAuthority(db, row, issue);
      const actor: AuthorizationActor = row.actorType === "agent"
        ? { type: "agent", companyId: row.companyId, agentId: row.actorId, runId: row.sourceRunId ?? undefined,
            onBehalfOfUserId: row.responsibleUserId, authorizingUserId }
        : { type: "board", companyIds: [row.companyId], userId: row.actorId === "board" ? undefined : row.actorId,
            source: row.actorId === "board" ? "local_implicit" : undefined, ignoreInstanceAdmin: true };
      await assertActorCanReadCase(db, actor, caseRow);
      await assertCaseTrustedForExecution(db, caseRow);
    } catch (error) {
      // Revoked case authority must not prevent an otherwise legitimate task
      // completion. Cancel this extra effect while retaining its audit trail.
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
      if (status !== 403 && status !== 404) throw error;
      invalidReason = "Terminal handoff authority is no longer available";
    }
  }
  if (invalidReason) {
    await cancelCaseHandoffsForIssue(db, { ...input, reason: invalidReason });
    return 0;
  }
  const at = new Date();
  await db.update(cases).set({ status: "done", completedAt: caseRow!.completedAt ?? at, phase: "done", updatedAt: at })
    .where(and(eq(cases.id, row.caseId), eq(cases.companyId, row.companyId)));
  await db.update(caseHandoffs).set({ state: "completed", completedAt: at, updatedAt: at,
    leaseExpiresAt: null, lastErrorCode: null, lastError: null }).where(eq(caseHandoffs.id, row.id));
  const details = { handoffId: row.id, issueId: issue.id, phase: "done", version: row.version,
    destinationKind: "done", state: "completed", issueStatusVersion: issue.statusVersion, workflowTransition: row.workflowTransition };
  await db.insert(caseEvents).values({ companyId: row.companyId, caseId: row.caseId, kind: "handoff_completed", actorType: "system",
    runId: row.sourceRunId, payload: details });
  const event = await persistActivity(db, { companyId: row.companyId, actorType: "system", actorId: "case-handoff",
    runId: row.sourceRunId, issueId: row.issueId, action: "case.handoff_completed", entityType: "case", entityId: row.caseId,
    responsibleUserIdOverride: row.responsibleUserId, details });
  input.publications?.push(event.publication);
  return 1;
}

/** A terminal run status alone is insufficient: the executor records this only after cleanup. */
export async function recordCaseHandoffExecutionReleased(db: Db, runId: string, issueId: string) {
  await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const handoff = await pendingCaseHandoffForRun(tx, runId);
    if (!handoff || handoff.issueId !== issueId) return;
    const at = new Date();
    const released = await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      ${JSON.stringify({ caseHandoffExecutionReleased: { schema: "paperclip.case-handoff-release.v1", runId, issueId,
        settledAt: at.toISOString() } })}::jsonb` }).where(and(eq(heartbeatRuns.id, runId),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "interrupted", "timed_out"]))).returning({ id: heartbeatRuns.id });
    if (!released.length) return;
    await tx.update(caseHandoffs).set({ nextAttemptAt: at, updatedAt: at }).where(and(eq(caseHandoffs.id, handoff.id),
      eq(caseHandoffs.state, "awaiting_release")));
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.caseHandoffs, handoff.companyId);
  });
}

export async function isCaseHandoffSourceReleased(db: Db, input: { runId: string; issueId: string }): Promise<boolean> {
  const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).then(rows => rows[0]);
  if (!run || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status) ||
      isNativeRunnerOwnershipHeld(run)) return false;
  const marker = run.resultJson?.caseHandoffExecutionReleased as Record<string, unknown> | undefined;
  if (await hasPendingRunCleanup(db, run.companyId, run.id)) return false;
  if (await getExecutionBlocker(db, run.companyId, input.issueId)) return false;
  if (marker?.schema === "paperclip.case-handoff-release.v1" && marker.runId === run.id && marker.issueId === input.issueId) return true;
  // A controller may die after cleanup but before writing its marker. Recover
  // only from host/provider-owned stop evidence, never a terminal status or an
  // expired controller lease. Workspace recovery remains an independent gate.
  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  // setRunStatusFromLive records bootstrap evidence when cancelling an
  // unclaimed queue entry. Its persisted absence of a first start and runtime
  // selection proves no provider or workspace executor was ever admitted.
  const neverStarted = run.status === "cancelled" && run.runtimeMode === "legacy" && !run.startedAt &&
    !run.runtimeModeResolvedAt && !run.processPid && !run.processGroupId && !run.runnerInstanceId && !run.nativeSessionId &&
    recovery?.kind === "bootstrap" && recovery.providerWorkStarted === false;
  const stopped = await remoteExecutionHasStopped(db, run.companyId, run.id) ||
    (run.runtimeMode === "native" && await hasNativeLocalProcessStop(db, run.companyId, run.id)) ||
    neverStarted ||
    await recoverLegacyCaseHandoffCleanup(db, run, input.issueId) ||
    (run.runtimeMode === "legacy" && recovery?.providerStopped === true && recovery?.sessionPreserved === true &&
      recovery?.actionOutcomes === "settled" && hasLegacyExecutionSettlement(run));
  if (!stopped) return false;
  await recordCaseHandoffExecutionReleased(db, run.id, input.issueId);
  return true;
}
