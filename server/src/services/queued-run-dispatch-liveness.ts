import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";

export const QUEUED_RUN_REDRIVE_AFTER_MS = 60_000;
export const QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS = 15 * 60_000;
export const QUEUED_RUN_REDRIVE_DELAY_MS = 1_000;
export const QUEUED_RUN_NOT_DISPATCHED = "queued_run_not_dispatched";

const NOT_READY_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
const UNDISPATCHED_PAGE_SIZE = 500;
const MAX_UNDISPATCHED_RUNS = 10_000;

export type UndispatchedQueuedRun = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  createdAt: Date;
};

type PageCursor = { at: string; runId: string };

async function listUndispatchedQueuedRunPage(db: Db, after: PageCursor | null, limit: number):
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

export async function listUndispatchedQueuedRuns(db: Db, options: { pageSize?: number; maxRuns?: number } = {}):
  Promise<UndispatchedQueuedRun[]> {
  const pageSize = options.pageSize ?? UNDISPATCHED_PAGE_SIZE;
  const maxRuns = options.maxRuns ?? MAX_UNDISPATCHED_RUNS;
  const runs: UndispatchedQueuedRun[] = [];
  let after: PageCursor | null = null;
  while (runs.length < maxRuns) {
    const page = await listUndispatchedQueuedRunPage(db, after, Math.min(pageSize, maxRuns - runs.length));
    runs.push(...page.map(({ cursorAt: _cursorAt, ...run }) => run));
    if (page.length < pageSize) break;
    const last = page[page.length - 1]!;
    after = { at: last.cursorAt, runId: last.runId };
  }
  return runs;
}

export function createQueuedRunRedriveSchedule(now: () => number = Date.now) {
  const attempts = new Map<string, { count: number; dueAt: number }>();
  return {
    plan(runs: readonly UndispatchedQueuedRun[]): { companyIds: string[]; nextAt: number | null } {
      const current = now();
      const live = new Set(runs.map(run => run.runId));
      for (const runId of attempts.keys()) if (!live.has(runId)) attempts.delete(runId);
      const companyIds = new Set<string>();
      let nextAt: number | null = null;
      for (const run of runs) {
        let state = attempts.get(run.runId) ?? { count: 0, dueAt: run.createdAt.getTime() + QUEUED_RUN_REDRIVE_AFTER_MS };
        let dueAt = state.dueAt;
        if (state.dueAt <= current) {
          companyIds.add(run.companyId);
          state = { count: state.count + 1,
            dueAt: current + Math.min(QUEUED_RUN_REDRIVE_AFTER_MS * 2 ** state.count, QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS) };
          dueAt = current + QUEUED_RUN_REDRIVE_DELAY_MS;
        }
        attempts.set(run.runId, state);
        nextAt = nextAt === null ? dueAt : Math.min(nextAt, dueAt);
      }
      return { companyIds: [...companyIds], nextAt };
    },
  };
}
