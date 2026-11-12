import { and, asc, eq, gte, notInArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { instanceSettingsService, isTruthyRuntimeEnvValue, resolveWorktreeRunExecutionActivation } from "./instance-settings.js";

export const QUEUED_RUN_REDRIVE_AFTER_MS = 60_000;
export const QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS = 15 * 60_000;
export const QUEUED_RUN_REDRIVE_DELAY_MS = 1_000;
export const QUEUED_RUN_NOT_DISPATCHED = "queued_run_not_dispatched";

const NOT_READY_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
const UNDISPATCHED_PAGE_SIZE = 500;

export type UndispatchedQueuedRun = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  createdAt: Date;
};

type PageCursor = { at: string; runId: string };

async function listUndispatchedQueuedRunPage(db: Db, companyId: string | undefined, createdAfter: Date | null | undefined,
  after: PageCursor | null, limit: number):
  Promise<Array<UndispatchedQueuedRun & { cursorAt: string }>> {
  return db.select({
    runId: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    issueId: sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    createdAt: heartbeatRuns.createdAt,
    cursorAt: sql<string>`${heartbeatRuns.createdAt}::text`,
  }).from(heartbeatRuns)
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.status, "queued"),
      companyId ? eq(heartbeatRuns.companyId, companyId) : undefined,
      createdAfter ? gte(heartbeatRuns.createdAt, createdAfter) : undefined,
      eq(companies.status, "active"),
      eq(agents.lifecycleState, "ready"),
      notInArray(agents.status, NOT_READY_AGENT_STATUSES),
      after ? sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${after.at}::timestamptz, ${after.runId}::uuid)` : undefined,
      sql`not exists (select 1 from ${heartbeatRuns} live
        where live.company_id = ${heartbeatRuns.companyId} and live.agent_id = ${heartbeatRuns.agentId}
          and live.status = 'running')`,
    ))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(limit);
}

/** Every undispatched queued run, read page by page with no cap; one
 * company's runs when `companyId` is given. `createdAfter` is the worktree
 * execution cutoff: dispatch never starts a run created before it. */
export async function listUndispatchedQueuedRuns(db: Db,
  options: { companyId?: string; createdAfter?: Date | null; pageSize?: number } = {}):
  Promise<UndispatchedQueuedRun[]> {
  const pageSize = options.pageSize ?? UNDISPATCHED_PAGE_SIZE;
  const runs: UndispatchedQueuedRun[] = [];
  let after: PageCursor | null = null;
  for (;;) {
    const page = await listUndispatchedQueuedRunPage(db, options.companyId, options.createdAfter, after, pageSize);
    runs.push(...page.map(({ cursorAt: _cursorAt, ...run }) => run));
    if (page.length < pageSize) return runs;
    const last = page[page.length - 1]!;
    after = { at: last.cursorAt, runId: last.runId };
  }
}

export type QueuedRunRedrivePlan = { companyIds: string[]; nextAt: number | null };

/** Re-drive deadlines for undispatched queued runs. `refresh` replaces the
 * tracked runs of the companies a dispatch pass just read (or of every company
 * after an instance-wide pass) and keeps the others, so a company-scoped pass
 * never reads another company's queue. */
export function createQueuedRunRedriveSchedule(now: () => number = Date.now) {
  const tracked = new Map<string, { run: UndispatchedQueuedRun; count: number; dueAt: number }>();
  return {
    refresh(scope: "all" | ReadonlySet<string>, runs: readonly UndispatchedQueuedRun[]): QueuedRunRedrivePlan {
      const current = now();
      const live = new Set(runs.map(run => run.runId));
      for (const [runId, entry] of tracked) {
        if ((scope === "all" || scope.has(entry.run.companyId)) && !live.has(runId)) tracked.delete(runId);
      }
      for (const run of runs) {
        const prior = tracked.get(run.runId);
        tracked.set(run.runId, prior ? { ...prior, run }
          : { run, count: 0, dueAt: run.createdAt.getTime() + QUEUED_RUN_REDRIVE_AFTER_MS });
      }
      const companyIds = new Set<string>();
      let nextAt: number | null = null;
      for (const [runId, entry] of tracked) {
        let dueAt = entry.dueAt;
        if (entry.dueAt <= current) {
          companyIds.add(entry.run.companyId);
          tracked.set(runId, { ...entry, count: entry.count + 1,
            dueAt: current + Math.min(QUEUED_RUN_REDRIVE_AFTER_MS * 2 ** entry.count, QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS) });
          dueAt = current + QUEUED_RUN_REDRIVE_DELAY_MS;
        }
        nextAt = nextAt === null ? dueAt : Math.min(nextAt, dueAt);
      }
      return { companyIds: [...companyIds], nextAt };
    },
  };
}

/** Whether this runtime dispatches queued runs at all, and from which
 * creation time, read the way dispatch reads them: a worktree runtime starts
 * nothing until worktree execution is armed, and then only runs created after
 * its cutoff. */
export async function readQueuedRunExecutionWindow(db: Db, runtimeEnv: Record<string, string | undefined> = process.env):
  Promise<{ dispatches: boolean; createdAfter: Date | null }> {
  if (!isTruthyRuntimeEnvValue(runtimeEnv.PAPERCLIP_IN_WORKTREE)) return { dispatches: true, createdAfter: null };
  const activation = resolveWorktreeRunExecutionActivation(await instanceSettingsService(db).getExperimental(),
    runtimeEnv.PAPERCLIP_INSTANCE_ID?.trim() || null);
  const cutoff = activation.armed ? new Date(activation.cutoff) : null;
  return cutoff && !Number.isNaN(cutoff.getTime()) ? { dispatches: true, createdAfter: cutoff }
    : { dispatches: false, createdAfter: null };
}
