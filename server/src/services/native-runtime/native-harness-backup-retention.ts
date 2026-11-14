import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeHarnessBackups, nativeRunFinalizations, type Db } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function retireObsoleteNativeHarnessBackup(tx: Transaction, input: {
  id: string; companyId: string; scopeDigest: string; closedBefore: Date; dryRun: boolean;
}): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.companyId}:${input.scopeDigest}`}, 0))`);
  const [candidate] = await tx.select().from(nativeHarnessBackups).where(and(
    eq(nativeHarnessBackups.id, input.id), eq(nativeHarnessBackups.companyId, input.companyId))).for("update");
  if (!candidate || !["pending", "superseded"].includes(candidate.status) || candidate.updatedAt >= input.closedBefore) return false;
  const [current] = await tx.select({ id: nativeHarnessBackups.id }).from(nativeHarnessBackups).where(and(
    eq(nativeHarnessBackups.companyId, input.companyId), eq(nativeHarnessBackups.scopeDigest, input.scopeDigest),
    eq(nativeHarnessBackups.status, "current"))).limit(1);
  if (!current && candidate.status === "superseded") return false;
  const [lease] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId),
    inArray(environmentLeases.status, ["active", "released", "retained", "pending_cleanup"]),
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'sessionScopeSha256' = ${input.scopeDigest}`,
    sql`${environmentLeases.metadata}->'nativeHarnessBackup'->>'manifestSha256' = ${candidate.manifestSha256}`)).limit(1);
  if (lease) return false;
  if (candidate.status === "pending") {
    const [run] = await tx.select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.runId));
    if (run && (!run.finishedAt || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status))) return false;
    const [owner] = await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.runId, candidate.runId), isNotNull(nativeRunFinalizations.leaseOwner))).limit(1);
    if (owner) return false;
  }
  if (!input.dryRun) await tx.update(nativeHarnessBackups).set({ status: "retired", updatedAt: new Date() })
    .where(eq(nativeHarnessBackups.id, candidate.id));
  return true;
}
