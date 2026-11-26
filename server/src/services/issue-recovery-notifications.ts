import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, type DeliveryQueue } from "./delivery-work-notifications.js";

/** What a task recovery queue re-checks for one hint.
 * - `{ companyId }`: tasks whose own rows changed since the queue last looked
 *   at the company (see changed-tasks.ts). Most writes change a task, run,
 *   wake, comment or agent row, so this finds what they affected.
 * - `everyTask`: every eligible task of the company. Only for a change that
 *   makes tasks eligible again without writing any of their rows, such as a
 *   company or project resume or a tree hold release.
 * - `agentId`: the tasks one agent is assigned, reviews or holds a run lock
 *   on, for an agent status change.
 * - `issueId` / graph: one task and its graph, for local facts.
 * - `backstop`: the queue's own changed-rows deadline (see recovery/work.ts).
 * - `reload`: a boot or a notification reconnect. Each company loads the rows
 *   changed since its saved full pass, or every task when none is recent. */
export type IssueRecoveryScope = { companyId: string; issueId?: string; graphRunId?: string; graphIssueId?: string; backstop?: true;
  everyTask?: true; agentId?: string; reload?: true; issueIds?: string[]; wholeCompany?: boolean };

export const ISSUE_RECOVERY_MAX_ISSUE_IDS = 100;
export const ISSUE_RECOVERY_BACKSTOP_MS = 5 * 60_000;
export const ISSUE_RECOVERY_FULL_BACKSTOP_MS = 60 * 60_000;
export const ISSUE_RECOVERY_MAX_AGENT_ISSUE_IDS = 2_000;
export const ISSUE_RECOVERY_RELOAD_HINT = JSON.stringify({ companyId: "", reload: true });
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const COMPANY_QUEUES: DeliveryQueue[] = [DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.taskWatchdogs];
export const ISSUE_RECOVERY_TASK_QUEUES: readonly DeliveryQueue[] = [DELIVERY_QUEUES.strandedAssignments,
  DELIVERY_QUEUES.assignedWorkInvariant, DELIVERY_QUEUES.resolvedDependencies, DELIVERY_QUEUES.staleIssueLocks];
const TASK_QUEUES = ISSUE_RECOVERY_TASK_QUEUES;

export async function notifyIssueRecovery(transaction: object,
  scope?: { companyId: string; issueId?: string; everyTask?: boolean }) {
  const companyHint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  const taskHint = !scope ? "*" : JSON.stringify({ companyId: scope.companyId,
    ...(scope.issueId ? { issueId: scope.issueId } : scope.everyTask ? { everyTask: true } : {}) });
  for (const queue of COMPANY_QUEUES) await notifyDeliveryWork(transaction, queue, companyHint);
  for (const queue of TASK_QUEUES) await notifyDeliveryWork(transaction, queue, taskHint);
}

/** An agent status change: the company queues, and on the task queues only
 * the tasks that agent is assigned, reviews or holds a run lock on. */
export async function notifyAgentRecovery(transaction: object, scope: { companyId: string; agentId: string }) {
  const companyHint = JSON.stringify({ companyId: scope.companyId });
  const agentHint = JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId });
  for (const queue of COMPANY_QUEUES) await notifyDeliveryWork(transaction, queue, companyHint);
  for (const queue of TASK_QUEUES) await notifyDeliveryWork(transaction, queue, agentHint);
}

export async function notifyCompanyRecovery(transaction: object, companyId: string) {
  const companyHint = JSON.stringify({ companyId });
  for (const queue of COMPANY_QUEUES) await notifyDeliveryWork(transaction, queue, companyHint);
}

export function issueRecoveryBackstopHint(companyId: string) {
  return JSON.stringify({ companyId, backstop: true });
}

export function decodeIssueRecoveryHint(hint: string): IssueRecoveryScope | undefined {
  return hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope;
}

export function issueRecoveryScopeMatches(entry: { id: string; companyId: string }, scope?: IssueRecoveryScope) {
  if (!scope) return true;
  if (scope.reload || entry.companyId !== scope.companyId) return false;
  if (scope.issueId) return entry.id === scope.issueId;
  if (scope.graphRunId || scope.graphIssueId || scope.agentId) return scope.wholeCompany === true || (scope.issueIds?.includes(entry.id) ?? false);
  return true;
}

/** The tasks an agent status change can affect: assigned to the agent, under
 * its current review, or locked by one of its runs. Null when there are too
 * many to list; the caller then re-checks every task of the company. */
export async function resolveAgentIssues(db: Db, scope: { companyId: string; agentId: string }): Promise<string[] | null> {
  const rows = await db.execute<{ id: string }>(sql`select i.id::text as id from issues i
    where i.company_id = ${scope.companyId}::uuid
      and (i.status not in ('done', 'cancelled') or i.checkout_run_id is not null or i.execution_run_id is not null)
      and (i.assignee_agent_id = ${scope.agentId}::uuid
        or (i.status = 'in_review' and i.execution_state->>'status' = 'pending'
          and i.execution_state->'currentParticipant'->>'type' = 'agent'
          and i.execution_state->'currentParticipant'->>'agentId' = ${scope.agentId})
        or exists (select 1 from heartbeat_runs r where r.company_id = i.company_id and r.agent_id = ${scope.agentId}::uuid
          and r.id in (i.checkout_run_id, i.execution_run_id)))
    limit ${ISSUE_RECOVERY_MAX_AGENT_ISSUE_IDS + 1}`);
  const ids = rows.map(row => row.id).sort();
  return ids.length <= ISSUE_RECOVERY_MAX_AGENT_ISSUE_IDS ? ids : null;
}

export async function notifyIssueGraphRecovery(transaction: object,
  scope: { companyId: string; runId?: string | null; issueId?: string | null }) {
  if (!scope.runId && !scope.issueId) return notifyIssueRecovery(transaction, { companyId: scope.companyId });
  const companyHint = JSON.stringify({ companyId: scope.companyId });
  for (const queue of COMPANY_QUEUES) await notifyDeliveryWork(transaction, queue, companyHint);
  const graphHint = JSON.stringify({ companyId: scope.companyId, graphRunId: scope.runId ?? undefined, graphIssueId: scope.issueId ?? undefined });
  for (const queue of TASK_QUEUES) await notifyDeliveryWork(transaction, queue, graphHint);
}

export async function resolveIssueGraph(db: Db, scope: { companyId: string; runId?: string; issueId?: string }): Promise<string[] | null> {
  const company = sql`${scope.companyId}::uuid`;
  const run = scope.runId ? sql`${scope.runId}::uuid` : sql`null::uuid`;
  const rows = await db.execute<{ id: string }>(sql`with seed(id) as (
      select id from issues where company_id = ${company} and id = ${scope.issueId ?? null}::uuid
      union select issue_id from heartbeat_runs where company_id = ${company} and id = ${run} and issue_id is not null
      union select native_issue_id from heartbeat_runs where company_id = ${company} and id = ${run} and native_issue_id is not null
      union select issue.id from heartbeat_runs run
        cross join lateral (select coalesce(run.context_snapshot->>'issueId', run.context_snapshot->>'taskId') as saved) context
        inner join issues issue on issue.company_id = run.company_id
          and issue.id = case when context.saved ~* ${UUID_PATTERN} then context.saved::uuid end
      where run.company_id = ${company} and run.id = ${run}
    ), affected(id) as (
      select id from seed
      union select parent_id from issues where company_id = ${company} and id in (select id from seed) and parent_id is not null
      union (select related_issue_id from issue_relations where company_id = ${company} and type = 'blocks'
        and issue_id in (select id from seed) limit ${ISSUE_RECOVERY_MAX_ISSUE_IDS + 1})
    ) select id::text as id from affected limit ${ISSUE_RECOVERY_MAX_ISSUE_IDS + 1}`);
  const issueIds = rows.map(row => row.id).sort();
  if (issueIds.length === 0) return scope.issueId ? null : [];
  return issueIds.length <= ISSUE_RECOVERY_MAX_ISSUE_IDS ? issueIds : null;
}
