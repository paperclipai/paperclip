import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  agents,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { isRecoverableControllerLeaseCancellation } from "../legacy-controller-lease-continuation.js";

type Scope = { companyId: string; issueId?: string; runId?: string };
type Entry = {
  id: string;
  companyId: string;
  issueId: string | null;
  dueAt: number;
};
export function registerControllerLeaseWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  schedule: (
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) => Promise<unknown>,
  canRun: () => boolean,
  enabled: () => Promise<boolean>,
) {
  const cursors = new Map<string, string>();
  let active = false;
  return registerScopedDeadlineWork<Entry, Scope>(
    coordinator,
    {
      queue: DELIVERY_QUEUES.legacyControllerLease,
      reconstructionIntervalMs: 30000,
      beforePass: async () => {
        active = await enabled();
      },
      decodeScope: (hint) =>
        hint === "*" ? undefined : (JSON.parse(hint) as Scope),
      scopeKey: {
        entry: (entry) => entry.companyId,
        scope: (scope) => scope.companyId,
      },
      matches: (entry, scope) =>
        !scope ||
        (entry.companyId === scope.companyId &&
          (!scope.runId || entry.id === scope.runId) &&
          (!scope.issueId || entry.issueId === scope.issueId)),
      load: async (scope) => {
        const key = JSON.stringify(scope ?? null),
          cursor = cursors.get(key);
        if (!active) {
          cursors.delete(key);
          return [];
        }
        const rows = await db
          .select({
            id: heartbeatRuns.id,
            companyId: heartbeatRuns.companyId,
            issueId: heartbeatRuns.issueId,
          })
          .from(agentTaskSessions)
          .innerJoin(
            heartbeatRuns,
            and(
              eq(heartbeatRuns.id, agentTaskSessions.lastRunId),
              eq(heartbeatRuns.companyId, agentTaskSessions.companyId),
              eq(heartbeatRuns.agentId, agentTaskSessions.agentId),
              eq(
                agentTaskSessions.adapterType,
                sql<string>`${heartbeatRuns.runnerProfileJson}->'adapterDispatch'->>'adapterType'`,
              ),
            ),
          )
          .innerJoin(
            issues,
            and(
              eq(issues.companyId, heartbeatRuns.companyId),
              eq(issues.id, heartbeatRuns.issueId),
            ),
          )
          .where(
            and(
              scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
              scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
              scope?.issueId ? eq(issues.id, scope.issueId) : undefined,
              cursor ? gt(heartbeatRuns.id, cursor) : undefined,
              eq(heartbeatRuns.runtimeMode, "legacy"),
              eq(heartbeatRuns.status, "cancelled"),
              eq(agentTaskSessions.taskKey, sql<string>`${issues.id}::text`),
              eq(issues.assigneeAgentId, heartbeatRuns.agentId),
              sql`${issues.hiddenAt} is null`,
              sql`${issues.assigneeUserId} is null and ${issues.status} in ('blocked','in_progress','in_review')`,
              sql`${heartbeatRuns.resultJson}#>>'{cancellation,source}' = 'controller_lease'
            and ${heartbeatRuns.resultJson}#>>'{controllerLeaseRecovery,exhaustedAt}' is null
            and exists(select 1 from agent_task_sessions s where s.company_id=${heartbeatRuns.companyId}
              and s.agent_id=${heartbeatRuns.agentId} and s.task_key=${issues.id}::text and s.last_run_id=${heartbeatRuns.id})
            and not exists(select 1 from heartbeat_runs child where child.company_id=${heartbeatRuns.companyId}
              and child.retry_of_run_id=${heartbeatRuns.id})`,
            ),
          )
          .orderBy(asc(heartbeatRuns.id))
          .limit(100);
        const complete = rows.length < 100;
        if (complete) cursors.delete(key);
        else cursors.set(key, rows.at(-1)!.id);
        return {
          complete,
          rows: rows.map((row) => ({ ...row, dueAt: Date.now() })),
        };
      },
      check: async (entry) => {
        if (!active) return null;
        const [run] = await db
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, entry.companyId),
              eq(heartbeatRuns.id, entry.id),
            ),
          );
        if (!run || !isRecoverableControllerLeaseCancellation(run)) return null;
        const [agent] = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.companyId, entry.companyId),
              eq(agents.id, run.agentId),
            ),
          );
        if (!agent) return null;
        await schedule(run, agent);
        return null;
      },
    },
    canRun,
  );
}
