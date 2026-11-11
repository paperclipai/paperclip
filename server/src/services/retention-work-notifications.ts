import { notifyApprovalWork } from "./approval-work-notifications.js";
import { RECOVERY_ORIGIN_KINDS, parseIssueGraphLivenessIncidentKey } from "./recovery/origins.js";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const ATTENTION_RETENTION_MAX_ISSUE_IDS = 100;
export type AttentionRetentionScope = { companyId?: string; sourceKind?: AttentionSourceKind;
  issueId?: string; issueIds?: string[]; sourceId?: string };

export async function notifyAttentionRetentionWork(transaction: object, scope: AttentionRetentionScope = {}) {
  const issueIds = [...new Set([...(scope.issueIds ?? []), ...(scope.issueId ? [scope.issueId] : [])])].sort();
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.attentionRetention, JSON.stringify({
    companyId: scope.companyId, sourceKind: scope.sourceKind, sourceId: scope.sourceId,
    issueId: issueIds.length === 1 ? issueIds[0] : undefined,
    issueIds: issueIds.length > 1 && issueIds.length <= ATTENTION_RETENTION_MAX_ISSUE_IDS ? issueIds : undefined,
  }));
}

export async function notifyIssueAttentionRetentionWork(transaction: object,
  scope: { companyId: string; issueId?: string; parentId?: string | null; runId?: string; originKind?: string | null; originId?: string | null }) {
  const database = transaction as Db;
  const seeds = [scope.issueId, scope.parentId].filter((id): id is string => Boolean(id));
  if (!seeds.length && scope.runId) {
    const rows = await database.execute(sql`select issue_id::text as id from heartbeat_runs
      where company_id = ${scope.companyId}::uuid and id = ${scope.runId}::uuid and issue_id is not null
      union select native_issue_id::text from heartbeat_runs
      where company_id = ${scope.companyId}::uuid and id = ${scope.runId}::uuid and native_issue_id is not null
      union select issue.id::text from heartbeat_runs run inner join issues issue
        on issue.company_id = run.company_id
          and issue.id::text = coalesce(run.context_snapshot->>'issueId', run.context_snapshot->>'taskId')
      where run.company_id = ${scope.companyId}::uuid and run.id = ${scope.runId}::uuid`);
    for (const row of rows) seeds.push(row.id as string);
  }
  if (!seeds.length) return notifyAttentionRetentionWork(transaction, { companyId: scope.companyId });
  const origins = await database.execute(sql`select id::text as id, origin_kind as "originKind", origin_id as "originId" from issues
    where company_id = ${scope.companyId}::uuid
      and id in (${sql.join([...new Set(seeds)].map(id => sql`${id}::uuid`), sql`, `)})`);
  const current = origins.find(source => source.id === scope.issueId);
  origins.push({ originKind: scope.originKind ?? current?.originKind, originId: scope.originId ?? current?.originId });
  const references: string[] = [];
  for (const source of origins) {
    if (source.originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery && typeof source.originId === "string") {
      references.push(source.originId);
    }
    const incident = source.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation
      ? parseIssueGraphLivenessIncidentKey(source.originId as string | null) : null;
    if (incident?.companyId === scope.companyId) references.push(incident.issueId, incident.leafIssueId);
  }
  if (references.length) {
    const trusted = await database.execute(sql`select id::text as id from issues
      where company_id = ${scope.companyId}::uuid
        and id::text in (${sql.join([...new Set(references)].map(id => sql`${id}`), sql`, `)})`);
    for (const row of trusted) seeds.push(row.id as string);
  }
  // UNION deduplicates visited UUIDs (including cycles). Each relation edge is
  // unique by schema, so 101 neighbours guarantee overflow of a 100-ID scope.
  // Bound that adjacency before materialization and stream at most 101 unique
  // IDs to the caller; an inner UNION DISTINCT would consume the full fan-in.
  const affected = await database.execute(sql`with recursive affected(id) as (
    select unnest(array[${sql.join([...new Set(seeds)].map(id => sql`${id}::uuid`), sql`, `)}])
    union
    select parent.id from affected current cross join lateral (
      (select related_issue_id as id from issue_relations where company_id = ${scope.companyId}::uuid
        and issue_id = current.id and type = 'blocks' limit ${ATTENTION_RETENTION_MAX_ISSUE_IDS + 1})
      union all select parent_id from issues where company_id = ${scope.companyId}::uuid
        and id = current.id and parent_id is not null
    ) parent
  ) select id::text as "issueId" from affected limit ${ATTENTION_RETENTION_MAX_ISSUE_IDS + 1}`);
  // The sentinel means the affected set is incomplete. Reconstruct the whole
  // company through the existing paged authority instead of dropping ancestors.
  await notifyAttentionRetentionWork(transaction, { companyId: scope.companyId,
    issueIds: affected.length <= ATTENTION_RETENTION_MAX_ISSUE_IDS ? affected.map(row => row.issueId as string) : undefined,
  });
}

export async function notifyRetentionWork(transaction: object, kind: AttentionSourceKind, scope: { companyId?: string; sourceId?: string } = {}) {
  if (kind === "approval") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
  if (kind === "join_request") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.joinRequestRetention);
  if (kind !== "approval" && kind !== "join_request") await notifyAttentionRetentionWork(transaction, { ...scope, sourceKind: kind,
    sourceId: kind === "blocker_attention" ? undefined : scope.sourceId });
}

export async function notifyCompanyRetentionWork(transaction: object, companyId: string) {
  await notifyAttentionRetentionWork(transaction, { companyId });
  await notifyApprovalWork(transaction, companyId);
  await notifyRetentionWork(transaction, "join_request");
}

export function writeJoinRequestChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyRetentionWork(tx, "join_request");
    return write(tx as unknown as Db);
  });
}
