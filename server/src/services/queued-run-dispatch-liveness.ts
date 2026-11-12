import { and, asc, eq, lte, notInArray, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";

export const QUEUED_RUN_REDRIVE_AFTER_MS = 60_000;
export const QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS = 15 * 60_000;
export const QUEUED_RUN_NOT_DISPATCHED = "queued_run_not_dispatched";

const NOT_READY_AGENT_STATUSES = ["paused", "terminated", "pending_approval"];
const MAX_UNDISPATCHED_RUNS = 500;

export type UndispatchedQueuedRun = {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  createdAt: Date;
};

export async function listUndispatchedQueuedRuns(db: Db, options: { createdBefore?: Date; limit?: number } = {}):
  Promise<UndispatchedQueuedRun[]> {
  const rows = await db.select({
    runId: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    issueId: sql<string | null>`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
    createdAt: heartbeatRuns.createdAt,
  }).from(heartbeatRuns)
    .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(
      eq(heartbeatRuns.status, "queued"),
      eq(companies.status, "active"),
      eq(agents.lifecycleState, "ready"),
      notInArray(agents.status, NOT_READY_AGENT_STATUSES),
      options.createdBefore ? lte(heartbeatRuns.createdAt, options.createdBefore) : undefined,
      sql`not exists (select 1 from ${heartbeatRuns} live
        where live.company_id = ${heartbeatRuns.companyId} and live.agent_id = ${heartbeatRuns.agentId}
          and live.status = 'running')`,
    ))
    .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
    .limit(Math.min(options.limit ?? MAX_UNDISPATCHED_RUNS, MAX_UNDISPATCHED_RUNS));
  return rows;
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
          dueAt = current;
        }
        attempts.set(run.runId, state);
        nextAt = nextAt === null ? dueAt : Math.min(nextAt, dueAt);
      }
      return { companyIds: [...companyIds], nextAt };
    },
  };
}
