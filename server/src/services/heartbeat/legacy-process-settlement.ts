import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { finishedLegacyControllerOwnerStamp, legacyControllerBootId } from "../legacy-controller-lease.js";
import { currentProcessProbe, proveOwnerGone } from "../owner-proof.js";
import { proveRunProcessGone } from "../run-process-owner.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

const schema = "paperclip.legacy-process-settlement.v1";
const statuses = ["failed", "timed_out", "interrupted"];
export type LegacyProcessSettlementSource = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "runtimeMode" | "controllerBootId" | "controllerLeaseExpiresAt" |
  "processPid" | "processGroupId" | "processStartedAt" | "finishedAt" | "status"> & { legacyProcessSettlement: unknown;
  startedAt?: Date | null; executionStage?: string | null };

function identityIsComplete(run: LegacyProcessSettlementSource) {
  return run.runtimeMode === "legacy" && statuses.includes(run.status) &&
    typeof run.controllerBootId === "string" && run.controllerBootId.length > 0 &&
    run.controllerLeaseExpiresAt === null && Number.isSafeInteger(run.processPid) && (run.processPid ?? 0) > 1 &&
    Number.isSafeInteger(run.processGroupId) && (run.processGroupId ?? 0) > 1 &&
    run.processStartedAt instanceof Date && Number.isFinite(run.processStartedAt.getTime()) &&
    run.finishedAt instanceof Date && Number.isFinite(run.finishedAt.getTime());
}

function receipt(run: LegacyProcessSettlementSource) {
  return { schema, runId: run.id, companyId: run.companyId, agentId: run.agentId,
    runtimeMode: "legacy", targetKind: "local", controllerBootId: run.controllerBootId,
    processPid: run.processPid, processGroupId: run.processGroupId,
    processStartedAt: run.processStartedAt!.toISOString(), finishedAt: run.finishedAt!.toISOString(), status: run.status };
}

function preparationIdentityIsComplete(run: LegacyProcessSettlementSource) {
  return run.runtimeMode === "legacy" && run.status === "failed" && run.executionStage === "preparing" &&
    typeof run.controllerBootId === "string" && run.controllerBootId.length > 0 && run.controllerLeaseExpiresAt === null &&
    run.processPid === null && run.processGroupId === null && run.processStartedAt === null &&
    run.startedAt instanceof Date && Number.isFinite(run.startedAt.getTime()) &&
    run.finishedAt instanceof Date && Number.isFinite(run.finishedAt.getTime()) && run.startedAt.getTime() <= run.finishedAt.getTime();
}

function preparationReceipt(run: LegacyProcessSettlementSource) {
  return { schema: "paperclip.legacy-preparation-settlement.v1", runId: run.id, companyId: run.companyId, agentId: run.agentId,
    runtimeMode: "legacy", targetKind: "not-dispatched", adapterDispatched: false, controllerBootId: run.controllerBootId,
    processPid: null, processGroupId: null, processStartedAt: null, executionStage: "preparing",
    startedAt: run.startedAt!.toISOString(), finishedAt: run.finishedAt!.toISOString(), status: run.status };
}

function matchesReceipt(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return Object.keys(proof).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => proof[key] === value);
}

export function legacySourceProcessSettled(run: LegacyProcessSettlementSource): boolean {
  if (run.runtimeMode !== "legacy" || !statuses.includes(run.status) || run.controllerLeaseExpiresAt !== null) return false;
  if (run.processPid === null && run.processGroupId === null && run.processStartedAt === null && run.controllerBootId === null)
    return run.legacyProcessSettlement === null;
  if (preparationIdentityIsComplete(run)) return matchesReceipt(run.legacyProcessSettlement, preparationReceipt(run));
  if (!identityIsComplete(run)) return false;
  const value: unknown = run.legacyProcessSettlement;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = receipt(run);
  const proof = value as Record<string, unknown>;
  return Object.keys(proof).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => proof[key] === value);
}

export async function recordLegacyProcessSettlement(db: Db, observed: LegacyProcessSettlementSource,
  canCommit: () => boolean): Promise<boolean> {
  if (!canCommit() || observed.controllerBootId !== legacyControllerBootId || !identityIsComplete(observed)) return false;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [current] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId, runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
      controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
      processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt, finishedAt: heartbeatRuns.finishedAt,
      legacyProcessSettlement: heartbeatRuns.legacyProcessSettlement,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, observed.id), eq(heartbeatRuns.companyId, observed.companyId),
      eq(heartbeatRuns.agentId, observed.agentId), eq(heartbeatRuns.runtimeMode, "legacy"),
      eq(heartbeatRuns.controllerBootId, legacyControllerBootId), isNull(heartbeatRuns.controllerLeaseExpiresAt),
      inArray(heartbeatRuns.status, statuses), eq(heartbeatRuns.status, observed.status),
      sql`(${heartbeatRuns.scheduledRetryAt} IS NULL OR ${heartbeatRuns.scheduledRetryAt} <= ${heartbeatRuns.finishedAt})`,
      eq(heartbeatRuns.finishedAt, observed.finishedAt!),
      eq(heartbeatRuns.processPid, observed.processPid!), eq(heartbeatRuns.processGroupId, observed.processGroupId!),
      eq(heartbeatRuns.processStartedAt, observed.processStartedAt!), isNull(heartbeatRuns.nativeIssueId),
      isNull(heartbeatRuns.nativeSessionId), isNull(heartbeatRuns.executionControlDeadlineAt),
      sql`NOT COALESCE(${heartbeatRuns.resultJson} ?| ARRAY['startupCancellation','cancellation','executionCancellation','nativeCancellation'], false)`,
    )).for("update");
    if (!current || !canCommit() || await hasPendingRunCleanup(tx, current.companyId, current.id) || !canCommit()) return false;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, current.companyId);
    if (!canCommit()) return false;
    const updated = await tx.update(heartbeatRuns).set({ legacyProcessSettlement: receipt(current) })
      .where(and(eq(heartbeatRuns.id, current.id), eq(heartbeatRuns.companyId, current.companyId)))
      .returning({ id: heartbeatRuns.id });
    return updated.length === 1;
  });
}

export async function recordLegacyPreparationSettlement(db: Db, observed: LegacyProcessSettlementSource,
  canCommit: () => boolean): Promise<boolean> {
  if (!canCommit() || observed.controllerBootId !== legacyControllerBootId || !preparationIdentityIsComplete(observed)) return false;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [current] = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId, runtimeMode: heartbeatRuns.runtimeMode, status: heartbeatRuns.status,
      controllerBootId: heartbeatRuns.controllerBootId, controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
      processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      executionStage: heartbeatRuns.executionStage, legacyProcessSettlement: heartbeatRuns.legacyProcessSettlement,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, observed.id), eq(heartbeatRuns.companyId, observed.companyId),
      eq(heartbeatRuns.agentId, observed.agentId), eq(heartbeatRuns.runtimeMode, "legacy"),
      eq(heartbeatRuns.controllerBootId, legacyControllerBootId), isNull(heartbeatRuns.controllerLeaseExpiresAt),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.executionStage, "preparing"),
      eq(heartbeatRuns.startedAt, observed.startedAt!), eq(heartbeatRuns.finishedAt, observed.finishedAt!),
      isNull(heartbeatRuns.processPid), isNull(heartbeatRuns.processGroupId), isNull(heartbeatRuns.processStartedAt),
      isNull(heartbeatRuns.legacyProcessSettlement), isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.nativeSessionId),
      isNull(heartbeatRuns.executionControlDeadlineAt), eq(heartbeatRuns.costAccountingPending, false),
      sql`(${heartbeatRuns.scheduledRetryAt} IS NULL OR ${heartbeatRuns.scheduledRetryAt} <= ${heartbeatRuns.finishedAt})`,
      sql`NOT COALESCE(${heartbeatRuns.resultJson} ?| ARRAY['startupCancellation','cancellation','executionCancellation','nativeCancellation'], false)`,
    )).for("update");
    if (!current || !preparationIdentityIsComplete(current) || !canCommit() ||
      await hasPendingRunCleanup(tx, current.companyId, current.id) || !canCommit()) return false;
    const updated = await tx.update(heartbeatRuns).set({ legacyProcessSettlement: preparationReceipt(current) })
      .where(and(eq(heartbeatRuns.id, current.id), eq(heartbeatRuns.companyId, current.companyId)))
      .returning({ id: heartbeatRuns.id });
    return updated.length === 1;
  });
}

export async function recoverLegacyProcessSettlement(db: Db, companyId: string, runId: string,
  currentBootIdle?: (runId: string) => boolean): Promise<boolean> {
  const readLeases = (tx: Db, lock = false) => {
    const query = tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    )).orderBy(asc(environmentLeases.id));
    return lock ? query.for('update', { skipLocked: true }) : query;
  };
  const [observed] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.runtimeMode, 'legacy'), eq(heartbeatRuns.costAccountingPending, true),
    isNull(heartbeatRuns.costAccountedAt),
    sql`${heartbeatRuns.usageJson}->>'accountingReceiptReady' = 'false'`,
  )).limit(1);
  if (!observed || !observed.costAccountingPending || observed.costAccountedAt
      || observed.usageJson?.accountingReceiptReady !== false || observed.usageJson?.accountingCaptureFailed === true
      || observed.usageJson?.accountingProviderWorkStarted === false
      || (observed.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted === false
      || !identityIsComplete(observed) || observed.nativeIssueId || observed.nativeSessionId
      || observed.executionControlDeadlineAt
      || observed.scheduledRetryAt && observed.scheduledRetryAt > observed.finishedAt!
      || ['startupCancellation','cancellation','executionCancellation','nativeCancellation']
        .some(key => observed.resultJson && Object.hasOwn(observed.resultJson, key))) return false;
  if (matchesReceipt(observed.legacyProcessSettlement, receipt(observed))) return true;
  if (observed.legacyProcessSettlement !== null) return false;
  const leases = await readLeases(db);
  if (leases.length === 0 || leases.some(lease => lease.provider !== 'local' || lease.providerLeaseId !== null
      || lease.metadata?.driver !== 'local' || !lease.releasedAt
      || !['released','expired','failed'].includes(lease.status))) return false;
  const owner = finishedLegacyControllerOwnerStamp(observed);
  if (!owner?.processStartedAt) return false;
  const probe = { ...currentProcessProbe(), readOnly: true };
  if (probe.processSpace === 'unknown' || observed.processHostHash !== probe.processSpace
      || owner.processSpace !== probe.processSpace) return false;
  const sameBoot = observed.controllerBootId === legacyControllerBootId;
  const locallyIdle = () => currentBootIdle ? currentBootIdle(runId) : !sameBoot;
  if (!locallyIdle()) return false;
  const controller = await proveOwnerGone(owner, probe);
  if (!(controller.verdict === 'gone'
      || sameBoot && controller.verdict === 'alive' && controller.reason === 'current_process'
        && locallyIdle())) return false;
  const child = await proveRunProcessGone(observed, 'legacy_accounting_receipt', probe);
  if (child?.verdict !== 'gone') return false;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [current] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
    )).for('update');
    if (!current || JSON.stringify(current) !== JSON.stringify(observed)
        || JSON.stringify(await readLeases(tx, true)) !== JSON.stringify(leases)
        || !locallyIdle()
        || await hasPendingRunCleanup(tx, companyId, runId)
        || !locallyIdle()) return false;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, companyId);
    if (!locallyIdle()) return false;
    const updated = await tx.update(heartbeatRuns).set({ legacyProcessSettlement: receipt(current) })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .returning({ id: heartbeatRuns.id });
    return updated.length === 1;
  });
}
