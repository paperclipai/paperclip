import { and, asc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, nativeRunFinalizations, nativeRunnerCheckpoints, type Db } from "@paperclipai/db";
import { inspectDurablePrpCheckpointHeader, type DurablePrpCheckpoint } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Claims and recovered-source writers lock both coordinators in this order. */
export async function lockSourceRecoveryCoordinators(tx: Transaction, companyId: string, runIds: readonly string[]) {
  return tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId),
    inArray(nativeRunFinalizations.runId, [...new Set(runIds)]))).orderBy(asc(nativeRunFinalizations.runId)).for("update");
}

export async function readNativeSourceConsumers(tx: Transaction, companyId: string, runId: string) {
  const retired = exists(tx.select({ runId: nativeRunnerCheckpoints.runId }).from(nativeRunnerCheckpoints).where(and(
    eq(nativeRunnerCheckpoints.companyId, companyId), eq(nativeRunnerCheckpoints.runId, runId),
    eq(nativeRunnerCheckpoints.part, "header"),
    sql`${nativeRunnerCheckpoints.material}->>'schema' like 'paperclip.native-runner-checkpoint-retirement.%'`)));
  return tx.select({ id: environmentLeases.id, metadata: environmentLeases.metadata, retired }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    or(sql`${environmentLeases.metadata}->'runnerTaskSourceConsumer' is not null`,
      sql`${environmentLeases.metadata}->'portableTaskSuccessor' is not null`)));
}

/** Physical source consumption revokes the completed controller's late writer. */
export async function assertNativeSourceCheckpointConsumer(tx: Transaction, owner: {
  companyId: string; runId: string; authorityRunId: string; bootId: string; generation: number;
}, checkpoint?: DurablePrpCheckpoint) {
  const rows = await readNativeSourceConsumers(tx, owner.companyId, owner.runId);
  if (rows.some(row => row.retired)) throw new Error("native_runner_checkpoint_retired");
  if (!rows.length) return;
  const deny = (): never => { throw new Error("native_runner_checkpoint_owner_lost"); };
  if (owner.runId === owner.authorityRunId || rows.length !== 1 || !checkpoint) return deny();
  const source = rows[0]!;
  const header = checkpoint.records.get("header");
  const identity = header ? inspectDurablePrpCheckpointHeader(header) : null;
  const portable = record(source.metadata?.portableTaskSuccessor);
  if (source.metadata?.portableTaskSuccessor !== undefined) {
    if (typeof portable.targetLeaseId !== "string" || portable.sourceLeaseId !== source.id ||
        !identity || nativeSha256(record(portable.operation).identity ?? null) !== nativeSha256(identity)) return deny();
    const [target] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, owner.companyId),
      eq(environmentLeases.id, portable.targetLeaseId)));
    if (!target || target.heartbeatRunId !== owner.authorityRunId || target.status !== "active" || target.releasedAt ||
        target.expiresAt && target.expiresAt.getTime() <= Date.now() ||
        target.metadata?.portableTaskOwnershipReady !== true || target.metadata.portableTaskSuccessor !== undefined ||
        nativeSha256(target.metadata.portableTaskPredecessor ?? null) !== nativeSha256(portable)) return deny();
    return;
  }
  const consumer = record(source.metadata?.runnerTaskSourceConsumer);
  if (typeof consumer.leaseId !== "string" || consumer.runId !== owner.authorityRunId) return deny();
  const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, owner.companyId),
    eq(environmentLeases.id, consumer.leaseId)));
  const recovery = record(lease?.metadata?.runnerTaskSourceRecovery);
  const expected = record(recovery.identity);
  if (!lease || lease.heartbeatRunId !== owner.authorityRunId || lease.status !== "active" || lease.releasedAt ||
      lease.expiresAt && lease.expiresAt.getTime() <= Date.now() ||
      recovery.schema !== "paperclip.runner.source-recovery.v1" || recovery.sourceLeaseId !== source.id ||
      recovery.consumerLeaseId !== lease.id || recovery.consumerRunId !== owner.authorityRunId ||
      typeof recovery.accountIdentity !== "string" || recovery.accountIdentity !== consumer.accountIdentity ||
      recovery.controllerBootId !== owner.bootId || recovery.controllerGeneration !== owner.generation ||
      ["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"].some(key =>
        typeof expected[key] !== "string" || expected[key] !== record(identity)[key] || expected[key] !== record(consumer.identity)[key])) return deny();
}
