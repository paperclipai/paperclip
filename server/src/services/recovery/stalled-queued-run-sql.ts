import { sql, type SQLWrapper } from "drizzle-orm";
import { OLDEST_DISPATCH_SHARE, QUEUED_RUN_AGING_MS } from "../heartbeat/queued-run-dispatch-order.js";
import { personOriginRunSql } from "../heartbeat/queued-run-line.js";

/**
 * The assigned-work sweep's test for a queued run the dispatcher keeps passing
 * over: its agent's oldest queued run, past the aging bound, with more than
 * OLDEST_DISPATCH_SHARE later starts that the dispatcher ranked no higher.
 */
export type StalledRunColumns = { id: SQLWrapper; companyId: SQLWrapper; agentId: SQLWrapper; status: SQLWrapper; createdAt: SQLWrapper };

const UUID_TEXT = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/**
 * A run people wait on, as the dispatcher ranks it: a person asked for it
 * (itself or through its source chain, the dispatcher's own rule) or its task
 * was created by a person. `alias` names a heartbeat_runs row in the enclosing query.
 */
function personWaitingRunSql(alias: string) {
  const run = (column: string) => sql.raw(`${alias}.${column}`);
  return sql`(${personOriginRunSql(sql`${run("company_id")}`, sql`${run("id")}`)}
    or exists (select 1 from issues person_task where person_task.company_id = ${run("company_id")}
      and person_task.id = case when ${run("context_snapshot")}->>'issueId' ~* ${UUID_TEXT}
        then (${run("context_snapshot")}->>'issueId')::uuid end
      and person_task.created_by_user_id is not null))`;
}

export function queuedRunStalledSql(run: StalledRunColumns, at: Date) {
  const agedBefore = new Date(at.getTime() - QUEUED_RUN_AGING_MS).toISOString();
  return sql<boolean>`(${run.status} = 'queued' and ${run.createdAt} <= ${agedBefore}::timestamptz
    and not exists (select 1 from heartbeat_runs older where older.company_id = ${run.companyId}
      and older.agent_id = ${run.agentId} and older.status = 'queued' and older.created_at < ${run.createdAt})
    and (select count(*) from (select 1 from heartbeat_runs started where started.company_id = ${run.companyId}
      and started.agent_id = ${run.agentId} and started.id <> ${run.id}
      -- Work people wait on goes ahead of a run they do not by design; it does not pass that run over.
      and not (${personWaitingRunSql("started")} and not exists (select 1 from heartbeat_runs waiting
        where waiting.id = ${run.id} and ${personWaitingRunSql("waiting")}))
      and started.started_at > greatest(${run.createdAt} + ${`${QUEUED_RUN_AGING_MS} milliseconds`}::interval,
        (select max(coalesce(prior.started_at, prior.finished_at)) from heartbeat_runs prior
          where prior.company_id = ${run.companyId} and prior.agent_id = ${run.agentId} and prior.created_at < ${run.createdAt}
            and (prior.started_at >= ${run.createdAt} or (prior.started_at is null and prior.finished_at >= ${run.createdAt}))))
      limit ${OLDEST_DISPATCH_SHARE + 1}) passed_over) > ${OLDEST_DISPATCH_SHARE})`;
}

export const aliasedRun = (alias: string): StalledRunColumns => ({ id: sql.raw(`${alias}.id`), companyId: sql.raw(`${alias}.company_id`),
  agentId: sql.raw(`${alias}.agent_id`), status: sql.raw(`${alias}.status`), createdAt: sql.raw(`${alias}.created_at`) });
