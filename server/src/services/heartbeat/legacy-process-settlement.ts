import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { legacyControllerBootId } from "../legacy-controller-lease.js";

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
      eq(heartbeatRuns.costAccountingPending, false),
      sql`NOT COALESCE(${heartbeatRuns.resultJson} ?| ARRAY['startupCancellation','cancellation','executionCancellation','nativeCancellation'], false)`,
    )).for("update");
    if (!current || !canCommit() || await hasPendingRunCleanup(tx, current.companyId, current.id) || !canCommit()) return false;
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
