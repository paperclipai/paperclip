import { and, asc, eq, sql } from "drizzle-orm";
import {
  executionWorkspaces,
  executionWorkspaceRestorePoints,
  executionWorkspaceRuntimeLeases,
  heartbeatRuns,
  issues,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { logActivity } from "./activity-log.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { logger } from "../middleware/logger.js";

/**
 * The execution workspace row janitor.
 *
 * The terminal workspace reaper archives a row. It never removes one, so the
 * `execution_workspaces` table grows by one row per run. This module removes
 * the rows that no longer have a user.
 *
 * A row is removed when all of these are true:
 *
 * 1. no run in status `queued` or `running` points to the row, through
 *    `issues.checkout_run_id`, `issues.execution_run_id`, or the row's
 *    `source_issue_id`,
 * 2. no live row in `execution_workspace_runtime_leases` for the row,
 * 3. no row in `workspace_runtime_services` with a live status for the row,
 * 4. no open issue points to the row,
 * 5. the source issue, and the source issue tree, are terminal,
 * 6. the row was not used and not updated for the cooldown period.
 *
 * These are the guards that a manual cleanup of 311 stale rows used.
 *
 * The module removes database rows only. It never removes or moves a file. A
 * row that still owns a worktree is therefore never a candidate: only a row
 * whose storage the archive path already released, and a row that is
 * bookkeeping for a shared project checkout, can be removed. The shared
 * checkout itself lives in `project_workspaces` and stays untouched.
 */

/** The first retry of a row that is due but blocked. */
export const EXECUTION_WORKSPACE_ROW_JANITOR_RETRY_BASE_MS = 60 * 60 * 1000;
/** The longest retry of a row that is due but blocked. */
export const EXECUTION_WORKSPACE_ROW_JANITOR_RETRY_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Mirrors `EXECUTION_WORKSPACE_REOPEN_PENDING_METADATA_KEY` in
 * `server/src/services/execution-workspaces.ts`. The value is repeated here
 * because the execution workspace service does not import this module.
 */
const REOPEN_PENDING_METADATA_KEY = "reopenPendingConsumption";

export type ExecutionWorkspaceRowJanitorOptions = {
  /** The sweeper runs. The default is true. */
  enabled?: boolean;
  /** How long a row must be unused and unupdated before it can be removed. */
  cooldownMs?: number;
  /** The sweeper reports the rows it would remove and removes none. */
  dryRun?: boolean;
  /** The clock. The default is the system clock. */
  now?: () => Date;
};

export type ExecutionWorkspaceRowJanitorResult = {
  /** The rows that were due and were examined. */
  checked: number;
  /** The rows that were removed. */
  removed: number;
  /** The rows that were due but that a guard kept. */
  skipped: number;
  /** The sweeper reported the rows instead of removing them. */
  dryRun: boolean;
};

/**
 * The moment a row becomes eligible for removal: the last time it was used,
 * the last time it was updated, and the moment the archive path declared it
 * eligible for cleanup. `cleanup_eligible_at` is written by the archive path
 * and was never read before this module.
 */
const janitorDueAt = sql<string>`GREATEST(
  ${executionWorkspaces.lastUsedAt},
  ${executionWorkspaces.updatedAt},
  COALESCE(${executionWorkspaces.cleanupEligibleAt}, '-infinity'::timestamptz)
)`;

/**
 * The rows this module may remove.
 *
 * A row qualifies when it holds no exclusive storage:
 *
 * - `local_fs` and `shared_workspace` is bookkeeping for a shared project
 *   checkout. The row owns no worktree, so removing it removes nothing on
 *   disk. The shared checkout lives in `project_workspaces` and stays.
 * - `archived` means the archive path already ran its cleanup and released the
 *   workspace artifacts. A row whose cleanup failed keeps its `cleanup_failed`
 *   status and stays, because its storage may still be present.
 *
 * A row that still has follow-up work pending keeps its storage, so it stays
 * too: a plugin workspace whose provider was not removed, a git cache
 * expiration, a nested clone migration, an isolated repository rehome, and an
 * isolated task directory. The terminal reaper owns those rows.
 */
function janitorRowClass() {
  return and(
    sql<boolean>`${executionWorkspaces.sourceIssueId} IS NOT NULL`,
    sql<boolean>`(${executionWorkspaces.metadata} ->> ${REOPEN_PENDING_METADATA_KEY}::text) IS DISTINCT FROM 'true'`,
    sql<boolean>`(
      (
        ${executionWorkspaces.providerType} = 'local_fs'
        AND ${executionWorkspaces.mode} = 'shared_workspace'
        AND ${executionWorkspaces.status} <> 'cleanup_failed'
      )
      OR (
        ${executionWorkspaces.status} = 'archived'
        AND (
          ${executionWorkspaces.providerType} <> 'plugin'
          OR ${executionWorkspaces.metadata} ->> 'workspaceProviderRemoved' = 'true'
        )
        AND (${executionWorkspaces.metadata} -> 'gitCacheExpiration' ->> 'completed') IS DISTINCT FROM 'false'
        AND (${executionWorkspaces.metadata} -> 'nestedCloneMigrationPending') IS NULL
        AND NOT (
          (${executionWorkspaces.metadata} -> 'isolatedRepositoryRehome') IS NOT NULL
          AND (${executionWorkspaces.metadata} -> 'isolatedRepositoryRehome' ->> 'cleanedAt') IS NULL
        )
        AND (${executionWorkspaces.metadata} -> 'isolatedTaskDirectoryRetention' ->> 'removed') IS DISTINCT FROM 'false'
      )
    )`,
  );
}

/** Guard 1. No live run reaches the row. */
function noLiveRun(companyId: string) {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${heartbeatRuns} live_run
    WHERE live_run.company_id = ${companyId}
      AND live_run.status IN ('queued', 'running')
      AND (
        live_run.issue_id = ${executionWorkspaces.sourceIssueId}
        OR EXISTS (
          SELECT 1
          FROM ${issues} linked_issue
          WHERE linked_issue.company_id = ${companyId}
            AND (
              linked_issue.execution_workspace_id = ${executionWorkspaces.id}
              OR linked_issue.id = ${executionWorkspaces.sourceIssueId}
            )
            AND (
              linked_issue.checkout_run_id = live_run.id
              OR linked_issue.execution_run_id = live_run.id
            )
        )
      )
  )`;
}

/** Guard 2. The lease table has no status column, so liveness is the expiry. */
function noLiveLease(nowIso: string) {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${executionWorkspaceRuntimeLeases} lease
    WHERE lease.execution_workspace_id = ${executionWorkspaces.id}
      AND lease.expires_at > ${nowIso}::timestamptz
  )`;
}

/** Guard 3. A service that is still starting still uses the row. */
function noLiveRuntimeService() {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${workspaceRuntimeServices} runtime_service
    WHERE runtime_service.execution_workspace_id = ${executionWorkspaces.id}
      AND runtime_service.status IN ('provisioning', 'starting', 'running')
  )`;
}

/** Guard 4. No open issue points to the row. */
function noOpenIssue() {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${issues} open_issue
    WHERE open_issue.execution_workspace_id = ${executionWorkspaces.id}
      AND open_issue.status NOT IN ('done', 'cancelled')
  )`;
}

/** Guard 5. The source issue is terminal. */
function sourceIssueTerminal(companyId: string) {
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM ${issues} source_issue
    WHERE source_issue.id = ${executionWorkspaces.sourceIssueId}
      AND source_issue.company_id = ${companyId}
      AND source_issue.status IN ('done', 'cancelled')
  )`;
}

/**
 * Guard 5, continued. A child issue of the source issue keeps the row, with
 * the same recursive walk the terminal reaper uses.
 */
function sourceTreeTerminal(companyId: string, sourceIssueId: string) {
  return sql<boolean>`NOT EXISTS (
    WITH RECURSIVE issue_tree(id, status) AS (
      SELECT root.id, root.status
      FROM ${issues} root
      WHERE root.company_id = ${companyId}
        AND root.id = ${sourceIssueId}
      UNION ALL
      SELECT child.id, child.status
      FROM ${issues} child
      JOIN issue_tree parent ON child.parent_id = parent.id
      WHERE child.company_id = ${companyId}
    )
    SELECT 1 FROM issue_tree WHERE status NOT IN ('done', 'cancelled')
  )`;
}

/**
 * A row with a live restore point holds the recovery data of the work in its
 * worktree. The restore point ledger has no foreign key to the workspace
 * table, so the janitor leaves the ledger to its own expiry service and keeps
 * any row that still holds a live restore point.
 */
function noLiveRestorePoint() {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${executionWorkspaceRestorePoints} restore_point
    WHERE restore_point.execution_workspace_id = ${executionWorkspaces.id}
      AND restore_point.status IN ('pending', 'active', 'expiring')
  )`;
}

/** Guard 6. The row was not used and not updated inside the cooldown. */
function cooldownElapsed(cutoffIso: string) {
  return and(
    sql<boolean>`${executionWorkspaces.lastUsedAt} <= ${cutoffIso}::timestamptz`,
    sql<boolean>`${executionWorkspaces.updatedAt} <= ${cutoffIso}::timestamptz`,
    // An archived row is only eligible when the archive path declared it
    // eligible for cleanup at least one cooldown ago.
    sql<boolean>`(
      ${executionWorkspaces.status} <> 'archived'
      OR ${executionWorkspaces.cleanupEligibleAt} <= ${cutoffIso}::timestamptz
    )`,
  );
}

function janitorGuards(input: {
  companyId: string;
  sourceIssueId: string;
  cutoffIso: string;
  nowIso: string;
}) {
  return and(
    eq(executionWorkspaces.companyId, input.companyId),
    eq(executionWorkspaces.sourceIssueId, input.sourceIssueId),
    janitorRowClass(),
    noLiveRun(input.companyId),
    noLiveLease(input.nowIso),
    noLiveRuntimeService(),
    noOpenIssue(),
    sourceIssueTerminal(input.companyId),
    sourceTreeTerminal(input.companyId, input.sourceIssueId),
    noLiveRestorePoint(),
    cooldownElapsed(input.cutoffIso),
  );
}

export function createExecutionWorkspaceRowJanitor(
  db: Db,
  opts: ExecutionWorkspaceRowJanitorOptions = {},
) {
  const enabled = opts.enabled ?? true;
  const dryRun = opts.dryRun ?? false;
  const cooldownMs = opts.cooldownMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? (() => new Date());
  // The retry deadlines of the rows that were due but that a guard kept. A
  // row that stays blocked is checked again later, because the event that
  // frees it does not always write to the database.
  const retryDeadlines = new Map<string, { retryAt: number; backoffMs: number }>();
  let sweepInProgress = false;
  let lastSkipLogAt = 0;

  function scheduleRetry(id: string, nowMs: number) {
    const previous = retryDeadlines.get(id);
    const backoffMs = Math.min(
      previous ? previous.backoffMs * 2 : EXECUTION_WORKSPACE_ROW_JANITOR_RETRY_BASE_MS,
      EXECUTION_WORKSPACE_ROW_JANITOR_RETRY_MAX_MS,
    );
    retryDeadlines.set(id, { retryAt: nowMs + backoffMs, backoffMs });
  }

  async function sweep(
    limit = 25,
    signal?: AbortSignal,
  ): Promise<ExecutionWorkspaceRowJanitorResult> {
    const result: ExecutionWorkspaceRowJanitorResult = { checked: 0, removed: 0, skipped: 0, dryRun };
    if (!enabled) return result;
    // Skip this sweep while another sweep runs. A concurrent sweep would share
    // the retry deadlines. A skipped tick is safe, because the next tick runs
    // the sweep with intact state.
    if (sweepInProgress) return result;
    sweepInProgress = true;
    try {
      const current = now();
      const nowIso = current.toISOString();
      const cutoffIso = new Date(current.getTime() - cooldownMs).toISOString();
      const candidates = await db
        .select({
          id: executionWorkspaces.id,
          companyId: executionWorkspaces.companyId,
          sourceIssueId: executionWorkspaces.sourceIssueId,
        })
        .from(executionWorkspaces)
        .where(and(janitorRowClass(), sql`${janitorDueAt} <= ${nowIso}::timestamptz`))
        .orderBy(asc(janitorDueAt), asc(executionWorkspaces.id))
        .limit(limit);
      result.checked = candidates.length;
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        const guards = janitorGuards({
          companyId: candidate.companyId,
          sourceIssueId: candidate.sourceIssueId!,
          cutoffIso,
          nowIso,
        });
        if (dryRun) {
          // The guards are the same in both statements, so a dry run reports
          // exactly the rows that a real run would remove.
          const matched = await db
            .select({ id: executionWorkspaces.id })
            .from(executionWorkspaces)
            .where(and(eq(executionWorkspaces.id, candidate.id), guards))
            .limit(1);
          if (matched.length > 0) {
            result.removed += 1;
          } else {
            result.skipped += 1;
            scheduleRetry(candidate.id, current.getTime());
          }
          continue;
        }
        // The delete takes the same advisory lock as the archive path, so a
        // reopen that publishes the row between the scan and the delete cannot
        // lose it. The statement re-checks every guard, so a row that changed
        // in the meantime is not removed.
        const removed = await withExecutionWorkspaceLifecycleLock(db, candidate.id, async (tx) => {
          return tx
            .delete(executionWorkspaces)
            .where(and(eq(executionWorkspaces.id, candidate.id), guards))
            .returning({ id: executionWorkspaces.id });
        });
        if (removed.length === 0) {
          result.skipped += 1;
          scheduleRetry(candidate.id, current.getTime());
          continue;
        }
        result.removed += 1;
        retryDeadlines.delete(candidate.id);
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "execution_workspace_row_janitor",
          action: "execution_workspace.stale_row_removed",
          entityType: "execution_workspace",
          entityId: candidate.id,
          details: {
            sourceIssueId: candidate.sourceIssueId,
            cooldownMs,
          },
        });
      }
      if (result.removed > 0) {
        logger.info(
          { event: "execution_workspace.row_janitor", ...result },
          "execution workspace row janitor removed stale rows",
        );
      } else if (result.checked > 0 && current.getTime() - lastSkipLogAt >= 10 * 60 * 1000) {
        lastSkipLogAt = current.getTime();
        logger.info(
          { event: "execution_workspace.row_janitor", ...result },
          "execution workspace row janitor kept every candidate",
        );
      }
      return result;
    } finally {
      sweepInProgress = false;
    }
  }

  /**
   * The next moment the sweeper has to run. It is the earliest retry deadline
   * of a row that was due but blocked, and the earliest moment a candidate row
   * leaves the cooldown. It is null when there is nothing to do, so the
   * worker stays quiet.
   */
  async function nextDeadline(): Promise<number | null> {
    if (!enabled) return null;
    const current = now();
    const nowMs = current.getTime();
    let next: number | null = null;
    for (const [id, entry] of retryDeadlines) {
      if (entry.retryAt <= nowMs) {
        retryDeadlines.delete(id);
        continue;
      }
      if (next === null || entry.retryAt < next) next = entry.retryAt;
    }
    const rows = await db
      .select({
        nextDue: sql<number | null>`(EXTRACT(EPOCH FROM (MIN(${janitorDueAt}))) * 1000)::double precision`,
      })
      .from(executionWorkspaces)
      .where(and(janitorRowClass(), sql`${janitorDueAt} > ${current.toISOString()}::timestamptz`));
    const nextDue = rows[0]?.nextDue ?? null;
    if (nextDue !== null && (next === null || nextDue < next)) next = nextDue;
    return next;
  }

  return { sweep, nextDeadline };
}
