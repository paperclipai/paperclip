import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { isLauncherCapacityFailure } from "@paperclipai/adapter-utils/launcher-capacity";

const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 5 * 60_000;
const MAX_FAILURE_EXPONENT = 6;
const HISTORY_PAGE_SIZE = 1_024;

/** Call inside the transaction that claims the run, after its ownership gates. */
export async function deferQueuedRunAfterStartupFailure(
  tx: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<boolean> {
  // The process-local start lock cannot serialize claims in different servers.
  // Keep this lock until the claim commits, including the first recovery probe.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`agent-startup:${run.companyId}:${run.agentId}`}, 0))`);
  // Snapshot running work first: finalization does not take the claim lock.
  // Retaining this observation prevents a probe that fails during the history
  // read from disappearing between two READ COMMITTED snapshots. Consult it
  // only after a qualifying failure, so healthy concurrency stays unchanged.
  const [running] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
    eq(heartbeatRuns.status, "running"),
  )).limit(1);

  let failures = 0;
  let latestFailureAt = 0;
  let providerNotBefore = 0;
  let cursor: { id: string; finishedAt: string } | undefined;
  // Healthy agents need only the newest outcome, not older output excerpts.
  let pageSize = 1;
  const now = Date.now();
  for (;;) {
    const recent = await tx.select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      exitCode: heartbeatRuns.exitCode,
      signal: heartbeatRuns.signal,
      finishedAt: heartbeatRuns.finishedAt,
      // Preserve database timestamp precision at page boundaries.
      finishedAtCursor: sql<string>`${heartbeatRuns.finishedAt}::text`,
      resultJson: heartbeatRuns.resultJson,
      usageJson: heartbeatRuns.usageJson,
      stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId),
      // Keep the fixed predicate literal so generic prepared plans can use
      // the partial completion index; null terminal completions still reset it.
      sql`${heartbeatRuns.startedAt} IS NOT NULL AND ${heartbeatRuns.status}
        IN ('failed', 'timed_out', 'succeeded', 'cancelled', 'interrupted')`,
      cursor ? sql`(${heartbeatRuns.finishedAt}, ${heartbeatRuns.id}) <
        (${cursor.finishedAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
    )).orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id)).limit(pageSize);

    for (const previous of recent) {
      const evidence = previous.resultJson?.executionRecovery as Record<string, unknown> | undefined;
      const usage = previous.usageJson ?? {};
      if (!["failed", "timed_out"].includes(previous.status) || !previous.finishedAt ||
          evidence?.kind !== "bootstrap" || evidence.providerWorkStarted !== false ||
          (previous.stdoutExcerpt?.trim() && !isLauncherCapacityFailure(previous)) ||
          [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens,
            usage.input_tokens, usage.output_tokens, usage.cached_input_tokens]
            .some((value) => typeof value === "number" && value > 0)) return false;
      failures = Math.min(MAX_FAILURE_EXPONENT + 1, failures + 1);
      latestFailureAt = Math.max(latestFailureAt, previous.finishedAt.getTime());
      const hint = previous.resultJson?.retryNotBefore ?? previous.resultJson?.transientRetryNotBefore;
      if (typeof hint === "string" || typeof hint === "number") {
        const parsed = new Date(hint).getTime();
        if (Number.isFinite(parsed)) providerNotBefore = Math.max(providerNotBefore, parsed);
      }
      const delayMs = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (failures - 1));
      // A qualifying prefix can already prove deferral. Older failures cannot
      // shorten this deadline. Leave queued requests and comments unchanged;
      // existing startup/periodic resumption and finalization retry the claim.
      if (running || Math.max(latestFailureAt + delayMs, providerNotBefore) > now) return true;
    }
    if (recent.length < pageSize) return false;
    // Cap the exponent, not the streak: an older failure can still carry a
    // future provider deadline. Completion order handles overlapping attempts.
    const last = recent[recent.length - 1]!;
    cursor = { id: last.id, finishedAt: last.finishedAtCursor };
    pageSize = HISTORY_PAGE_SIZE;
  }
}
