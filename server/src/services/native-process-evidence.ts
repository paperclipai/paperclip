import { and, eq } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, nativeRunProcessEvidence, type Db } from "@paperclipai/db";
import { readRunEventLane } from "./run-event-history.js";

export const NATIVE_PROCESS_EVENT_TYPES = ["native.process_start_requested", "native.process_identity_recorded", "native.local_process_stopped"] as const;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const pid = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value <= 2_147_483_647 ? value : null;

/** Only call under the run row lock, in the same transaction as event append. */
export async function recordNativeProcessEvidence(tx: Transaction, row: typeof heartbeatRunEvents.$inferSelect): Promise<void> {
  if (row.sourceEventId !== null || !NATIVE_PROCESS_EVENT_TYPES.includes(row.eventType as typeof NATIVE_PROCESS_EVENT_TYPES[number])) return;
  const value = { companyId: row.companyId, runId: row.runId, seq: row.seq, eventType: row.eventType,
    processPid: pid(row.payload?.processPid), processGroupId: pid(row.payload?.processGroupId) };
  await tx.insert(nativeRunProcessEvidence).values(value).onConflictDoUpdate({
    target: [nativeRunProcessEvidence.companyId, nativeRunProcessEvidence.runId], set: value,
  });
}

/** Older runs need one bounded-memory compatibility scan. Persist even the
 * absence of process evidence, so old/no-process sessions never rescan output.
 * The run lock fences concurrent launch/stop writers during this backfill. */
export async function readNativeProcessEvidence(db: Db, companyId: string, runId: string) {
  const scope = and(eq(nativeRunProcessEvidence.companyId, companyId), eq(nativeRunProcessEvidence.runId, runId));
  const [current] = await db.select().from(nativeRunProcessEvidence).where(scope);
  if (current) return current;
  return db.transaction(async tx => {
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("update");
    if (!run) return null;
    const [existing] = await tx.select().from(nativeRunProcessEvidence).where(scope);
    if (existing) return existing;
    const [latest] = await readRunEventLane(tx as unknown as Db, runId, "native-process", 1);
    if (latest) await recordNativeProcessEvidence(tx, latest);
    else await tx.insert(nativeRunProcessEvidence).values({ companyId, runId, seq: 0 });
    const [saved] = await tx.select().from(nativeRunProcessEvidence).where(scope);
    return saved!;
  });
}
