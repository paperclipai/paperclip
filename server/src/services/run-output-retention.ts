import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentRuntimeState,
  agentTaskSessions,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import { getRunLogStore } from "./run-log-store.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"];

export type RunOutputPurgeResult = {
  runId: string;
  companyId: string;
  alreadyPurged: boolean;
  clearedSessionArtifacts: number;
};

/**
 * Remove content-bearing run data while retaining the row that proves the run
 * happened. This intentionally keeps status, timestamps, usage and event
 * identity/ordering, but clears the text/payload attached to those events.
 */
export async function purgeHeartbeatRunOutput(db: Db, runId: string): Promise<RunOutputPurgeResult | null> {
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) return null;

  const alreadyPurged = !run.logRef && !run.logStore && !run.resultJson &&
    !run.stdoutExcerpt && !run.stderrExcerpt && !run.error &&
    !run.sessionIdBefore && !run.sessionIdAfter;

  // Delete physical content before clearing its reference. A transient storage
  // failure leaves the database retryable rather than falsely claiming a purge.
  if (run.logStore && run.logRef) {
    await getRunLogStore().remove({ store: run.logStore as "local_file", logRef: run.logRef });
  }

  const now = new Date();
  const clearedSessions = await db.transaction(async (tx) => {
    await tx
      .update(heartbeatRunEvents)
      .set({ message: null, payload: null })
      .where(eq(heartbeatRunEvents.runId, run.id));

    await tx
      .update(heartbeatRuns)
      .set({
        error: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, run.id));

    const sessions = await tx
      .delete(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, run.companyId), eq(agentTaskSessions.lastRunId, run.id)))
      .returning({ id: agentTaskSessions.id });

    await tx
      .update(agentRuntimeState)
      .set({ sessionId: null, stateJson: {}, lastError: null, updatedAt: now })
      .where(and(eq(agentRuntimeState.companyId, run.companyId), eq(agentRuntimeState.lastRunId, run.id)));

    return sessions.length;
  });

  return {
    runId: run.id,
    companyId: run.companyId,
    alreadyPurged,
    clearedSessionArtifacts: clearedSessions,
  };
}

export function readRunOutputRetentionDays(value = process.env.HEARTBEAT_RUN_OUTPUT_RETENTION_DAYS): number | null {
  if (value === undefined || value.trim() === "") return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.floor(days);
}

export async function pruneExpiredHeartbeatRunOutput(
  db: Db,
  retentionDays: number | null = readRunOutputRetentionDays(),
  now = new Date(),
): Promise<number> {
  if (retentionDays === null) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.status, TERMINAL_RUN_STATUSES), lt(heartbeatRuns.finishedAt, cutoff)))
    .limit(250);

  let pruned = 0;
  for (const candidate of candidates) {
    const result = await purgeHeartbeatRunOutput(db, candidate.id);
    if (result && !result.alreadyPurged) pruned += 1;
  }
  return pruned;
}

export function startHeartbeatRunOutputRetention(db: Db, intervalMs = 60 * 60 * 1_000) {
  const sweep = () => pruneExpiredHeartbeatRunOutput(db).catch(() => undefined);
  sweep();
  const timer = setInterval(sweep, intervalMs);
  return () => clearInterval(timer);
}
