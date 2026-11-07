import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logRunTransitionAfterCommit } from "./lifecycle-events.js";

export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export type HeartbeatRunStatusPatch = Omit<PgUpdateSetSource<typeof heartbeatRuns>, "id" | "status">;

export type HeartbeatRunValuesPatch = Partial<Omit<typeof heartbeatRuns.$inferInsert, "id" | "status">>;

export interface HeartbeatRunStatusTransition {
  eventId: string;
  runId: string;
  fromStatus: string;
  toStatus: string;
  transitionedAtEpochUs: string;
}

export interface TransitionHeartbeatRunStatusOptions {
  toStatus: string;
  patch?: HeartbeatRunStatusPatch;
  where?: SQL;
  /**
   * The caller already holds the run row lock in this transaction and read this status under it.
   * The transition then does not select the row again; `where` applies to the update.
   */
  locked?: { status: string };
}

export async function transitionHeartbeatRunStatus(
  dbOrTx: Db | DbTransaction,
  runId: string,
  options: TransitionHeartbeatRunStatusOptions,
): Promise<{ run: HeartbeatRun; transition: HeartbeatRunStatusTransition | null } | null> {
  if (options.patch && "status" in options.patch) {
    throw new Error("transitionHeartbeatRunStatus: pass the status as toStatus, not in the patch");
  }
  const runInTransaction = async (tx: DbTransaction) => {
    const where = options.where ? and(eq(heartbeatRuns.id, runId), options.where) : eq(heartbeatRuns.id, runId);
    if (options.locked) return transitionLockedRun(tx, runId, where, options, options.locked.status);
    const [locked] = await tx
      .select({
        status: heartbeatRuns.status,
        transitionedAtEpochUs: sql<string>`(extract(epoch from clock_timestamp()) * 1000000)::bigint::text`,
      })
      .from(heartbeatRuns)
      .where(where)
      .for("update");
    if (!locked) return null;

    if (locked.status === options.toStatus) {
      const run = options.patch && Object.keys(options.patch).length > 0
        ? (await tx.update(heartbeatRuns).set(options.patch).where(eq(heartbeatRuns.id, runId)).returning())[0]
        : (await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
      return run ? { run, transition: null } : null;
    }

    const [run] = await tx
      .update(heartbeatRuns)
      .set({ ...options.patch, status: options.toStatus })
      .where(eq(heartbeatRuns.id, runId))
      .returning();
    if (!run) return null;
    const transition = {
      eventId: `run:${runId}:${locked.transitionedAtEpochUs}:${options.toStatus}`,
      runId,
      fromStatus: locked.status,
      toStatus: options.toStatus,
      transitionedAtEpochUs: locked.transitionedAtEpochUs,
    };
    logRunTransitionAfterCommit(tx, run, transition);
    return { run, transition };
  };
  return "rollback" in dbOrTx || typeof dbOrTx.transaction !== "function"
    ? runInTransaction(dbOrTx as DbTransaction)
    : dbOrTx.transaction(runInTransaction);
}

async function transitionLockedRun(
  tx: DbTransaction,
  runId: string,
  where: SQL | undefined,
  options: TransitionHeartbeatRunStatusOptions,
  fromStatus: string,
): Promise<{ run: HeartbeatRun; transition: HeartbeatRunStatusTransition | null } | null> {
  const sameStatus = fromStatus === options.toStatus;
  const hasPatch = Boolean(options.patch && Object.keys(options.patch).length > 0);
  if (sameStatus && !hasPatch) {
    const [run] = await tx.select().from(heartbeatRuns).where(where);
    return run ? { run, transition: null } : null;
  }
  const [clock] = (await tx.execute(
    sql`select (extract(epoch from clock_timestamp()) * 1000000)::bigint::text as "transitionedAtEpochUs"`,
  )) as unknown as Array<{ transitionedAtEpochUs: string }>;
  const [run] = await tx
    .update(heartbeatRuns)
    .set(sameStatus ? { ...options.patch } : { ...options.patch, status: options.toStatus })
    .where(where)
    .returning();
  if (!run) return null;
  if (sameStatus) return { run, transition: null };
  const transitionedAtEpochUs = String(clock?.transitionedAtEpochUs);
  return {
    run,
    transition: {
      eventId: `run:${runId}:${transitionedAtEpochUs}:${options.toStatus}`,
      runId,
      fromStatus,
      toStatus: options.toStatus,
      transitionedAtEpochUs,
    },
  };
}
