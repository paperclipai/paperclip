import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";

export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const DETACHED_PROCESS_ERROR_CODE = "process_detached";

export function isCheckoutOwningRunOrphan(input: {
  runStatus: string | null;
  runErrorCode: string | null;
  runUpdatedAt: Date | null;
  hasInMemoryHandle: boolean;
  now: Date;
  staleThresholdMs: number;
}): boolean {
  if (!input.runStatus) return true;

  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(input.runStatus)) {
    return true;
  }

  if (
    input.runStatus === "running" &&
    input.runErrorCode === DETACHED_PROCESS_ERROR_CODE &&
    !input.hasInMemoryHandle
  ) {
    if (input.staleThresholdMs === 0) return true;
    const refTime = input.runUpdatedAt ? input.runUpdatedAt.getTime() : 0;
    return input.now.getTime() - refTime >= input.staleThresholdMs;
  }

  return false;
}

export async function reapOrphanCheckouts(
  db: Db,
  opts: {
    now?: Date;
    staleThresholdMs?: number;
    hasInMemoryRunHandle: (runId: string) => boolean;
    companyId?: string;
  },
): Promise<{
  reaped: number;
  issueIds: string[];
  entries: Array<{
    issueId: string;
    companyId: string;
    identifier: string | null;
    checkoutRunId: string;
  }>;
}> {
  const now = opts.now ?? new Date();
  const staleThresholdMs = opts.staleThresholdMs ?? 0;

  const lockedIssues = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
      runStatus: heartbeatRuns.status,
      runErrorCode: heartbeatRuns.errorCode,
      runUpdatedAt: heartbeatRuns.updatedAt,
    })
    .from(issues)
    .leftJoin(heartbeatRuns, eq(issues.checkoutRunId, heartbeatRuns.id))
    .where(
      and(
        isNotNull(issues.checkoutRunId),
        opts.companyId ? eq(issues.companyId, opts.companyId) : undefined,
      ),
    );

  const reapedIssueIds: string[] = [];
  const reapedEntries: Array<{
    issueId: string;
    companyId: string;
    identifier: string | null;
    checkoutRunId: string;
  }> = [];

  for (const row of lockedIssues) {
    if (!row.checkoutRunId) continue;
    const checkoutRunId = row.checkoutRunId;

    if (
      !isCheckoutOwningRunOrphan({
        runStatus: row.runStatus,
        runErrorCode: row.runErrorCode,
        runUpdatedAt: row.runUpdatedAt,
        hasInMemoryHandle: opts.hasInMemoryRunHandle(checkoutRunId),
        now,
        staleThresholdMs,
      })
    ) {
      continue;
    }

    const cleared = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${row.id} for update`,
      );
      const current = await tx
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, row.id))
        .then((rows: Array<{ checkoutRunId: string | null; executionRunId: string | null }>) => rows[0] ?? null);
      if (!current || current.checkoutRunId !== checkoutRunId) return false;

      const patch: Partial<typeof issues.$inferInsert> = {
        checkoutRunId: null,
        updatedAt: now,
      };
      if (current.executionRunId === checkoutRunId) {
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const updated = await tx
        .update(issues)
        .set(patch)
        .where(and(eq(issues.id, row.id), eq(issues.checkoutRunId, checkoutRunId)))
        .returning({ id: issues.id })
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);

      return Boolean(updated);
    });

    if (cleared) {
      reapedIssueIds.push(row.id);
      reapedEntries.push({
        issueId: row.id,
        companyId: row.companyId,
        identifier: row.identifier,
        checkoutRunId,
      });
    }
  }

  return { reaped: reapedIssueIds.length, issueIds: reapedIssueIds, entries: reapedEntries };
}
