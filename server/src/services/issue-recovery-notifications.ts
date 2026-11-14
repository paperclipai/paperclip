import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, type DeliveryQueue } from "./delivery-work-notifications.js";

/** An issue hint is reserved for local facts such as comments. Lifecycle,
 * graph, run and eligibility changes retain company scope because their
 * consequences can include ancestors and shared execution references. */
export type IssueRecoveryScope = { companyId: string; issueId?: string; graphRunId?: string; graphIssueId?: string; backstop?: true;
  issueIds?: string[]; wholeCompany?: boolean };

export const ISSUE_RECOVERY_MAX_ISSUE_IDS = 100;
export const ISSUE_RECOVERY_BACKSTOP_MS = 5 * 60_000;
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const COMPANY_QUEUES: DeliveryQueue[] = [DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.taskWatchdogs];
const TASK_QUEUES: DeliveryQueue[] = [DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.assignedWorkInvariant,
  DELIVERY_QUEUES.resolvedDependencies, DELIVERY_QUEUES.staleIssueLocks];

export async function notifyIssueRecovery(transaction: object, scope?: IssueRecoveryScope) {
  const companyHint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  const issueHint = scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }) : "*";
  for (const queue of [DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.assignedWorkInvariant, DELIVERY_QUEUES.resolvedDependencies,
    DELIVERY_QUEUES.taskWatchdogs, DELIVERY_QUEUES.staleIssueLocks]) {
    await notifyDeliveryWork(transaction, queue,
      queue === DELIVERY_QUEUES.strandedAssignments || queue === DELIVERY_QUEUES.staleIssueLocks ? issueHint : companyHint);
  }
}

export function decodeIssueRecoveryHint(hint: string): IssueRecoveryScope | undefined {
  return hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope;
}

export function issueRecoveryScopeMatches(entry: { id: string; companyId: string }, scope?: IssueRecoveryScope) {
  if (!scope) return true;
  if (entry.companyId !== scope.companyId) return false;
  if (scope.issueId) return entry.id === scope.issueId;
  if (scope.graphRunId || scope.graphIssueId) return scope.wholeCompany === true || (scope.issueIds?.includes(entry.id) ?? false);
  return true;
}

export async function notifyIssueGraphRecovery(transaction: object,
  scope: { companyId: string; runId?: string | null; issueId?: string | null }) {
  if (!scope.runId && !scope.issueId) return notifyIssueRecovery(transaction, { companyId: scope.companyId });
  const companyHint = JSON.stringify({ companyId: scope.companyId });
  for (const queue of COMPANY_QUEUES) await notifyDeliveryWork(transaction, queue, companyHint);
  const graphHint = JSON.stringify({ companyId: scope.companyId, graphRunId: scope.runId ?? undefined, graphIssueId: scope.issueId ?? undefined });
  for (const queue of TASK_QUEUES) {
    await notifyDeliveryWork(transaction, queue, graphHint);
    await notifyDeliveryWork(transaction, queue, JSON.stringify({ companyId: scope.companyId, backstop: true }));
  }
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
  return issueIds.length && issueIds.length <= ISSUE_RECOVERY_MAX_ISSUE_IDS ? issueIds : null;
}
