import type { Db } from "@paperclipai/db";

const SESSION_RETENTION_BLOCKERS_SQL = `
with input as (
  select * from jsonb_to_recordset($1::jsonb) as i(key text, run_id uuid, session_id uuid, scope_digest text, lease_id uuid)
), owner as (
  select i.*, r.company_id, r.agent_id, coalesce(r.native_issue_id, r.issue_id) as owner_issue_id
  from input i join heartbeat_runs r on r.id = i.run_id
), sessions as (
  select o.key, o.run_id, o.session_id, o.scope_digest, o.lease_id, o.company_id, o.agent_id, o.owner_issue_id,
    coalesce(array_agg(r.id order by r.id) filter (where r.id is not null), '{}') as run_ids,
    coalesce(array_agg(distinct coalesce(r.native_issue_id, r.issue_id)) filter (where coalesce(r.native_issue_id, r.issue_id) is not null), '{}') as issue_ids,
    coalesce(bool_or(r.status in ('queued', 'scheduled_retry', 'running') or r.finished_at is null), false) as live,
    coalesce(bool_or((r.runner_profile_json->'nativeControllerRecovery'->>'schema' = 'paperclip.native-controller-recovery.v1'
      and r.runner_profile_json->'nativeControllerRecovery'->'checkpoint' = 'null'::jsonb) is true), false) as incomplete,
    coalesce(bool_or(r.finished_at >= $2::timestamptz), false) as recent
  from owner o
  left join heartbeat_runs r on r.company_id = o.company_id and r.agent_id = o.agent_id and r.native_session_id = o.session_id
  group by o.key, o.run_id, o.session_id, o.scope_digest, o.lease_id, o.company_id, o.agent_id, o.owner_issue_id
), assessed as (
  select s.*,
    (select count(*) from issues x where x.company_id = s.company_id and x.id = any(s.issue_ids)) as issues_found,
    exists (select 1 from issues x where x.company_id = s.company_id and x.id = any(s.issue_ids)
      and x.status not in ('done', 'cancelled')) as issue_open,
    exists (select 1 from issues x where x.company_id = s.company_id and x.id = any(s.issue_ids)
      and x.execution_run_id is not null) as issue_executing,
    exists (select 1 from issues x where x.company_id = s.company_id and x.id = any(s.issue_ids)
      and (coalesce(x.completed_at, x.cancelled_at) is null or coalesce(x.completed_at, x.cancelled_at) >= $2::timestamptz)) as issue_recent,
    (select (extract(epoch from max(coalesce(x.completed_at, x.cancelled_at))) * 1000)::float8 from issues x
      where x.company_id = s.company_id and x.id = any(s.issue_ids)) as closed_at,
    (select count(*) from native_run_finalizations f where f.run_id = any(s.run_ids)) as finalizations,
    exists (select 1 from native_run_finalizations f where f.run_id = any(s.run_ids)
      and (f.phase not in ('committed', 'terminal_failure') or f.lease_owner is not null)) as finalization_pending,
    exists (select 1 from (
      select l.status from environment_leases l where l.heartbeat_run_id = any(s.run_ids)
      union all select l.status from environment_leases l
        where l.metadata->'nativeHarnessBackup'->>'sessionScopeSha256' = s.scope_digest
      union all select l.status from environment_leases l where $3::boolean and l.company_id = s.company_id and l.issue_id = any(s.issue_ids)
      union all select l.status from environment_leases l where $3::boolean and l.company_id = s.company_id
        and l.metadata->'nativeHarnessBackup'->>'normalizedSessionId' = s.session_id::text
      union all select l.status from environment_leases l where l.id = s.lease_id
    ) referenced where referenced.status in ('active', 'released', 'retained', 'pending_cleanup')) as lease_live,
    coalesce((select array_agg(distinct referenced.id order by referenced.id) from (
      select l.id from environment_leases l where l.company_id = s.company_id and l.heartbeat_run_id = any(s.run_ids || s.run_id)
      union all select l.id from environment_leases l where l.company_id = s.company_id
        and l.metadata->'nativeHarnessBackup'->>'sessionScopeSha256' = s.scope_digest
      union all select l.id from environment_leases l where l.company_id = s.company_id and l.id = s.lease_id
    ) referenced), '{}') as lease_ids,
    exists (select 1 from agent_task_sessions t where t.company_id = s.company_id and t.agent_id = s.agent_id
      and (t.last_run_id = any(s.run_ids) or t.session_params_json->>'sessionId' = s.session_id::text)) as resumable
  from sessions s
)
select i.key, a.company_id, a.agent_id, a.run_ids, a.issue_ids, a.owner_issue_id, a.lease_ids, a.closed_at, coalesce(a.resumable, false) as resumable,
  case
    when a.key is null then 'run_missing'
    when a.live then 'live_run'
    when a.incomplete then 'native_recovery_incomplete'
    when $3::boolean and a.recent then 'recent_run'
    when cardinality(a.issue_ids) = 0 or a.issues_found <> cardinality(a.issue_ids) then 'issue_unknown'
    when a.issue_open then 'issue_open'
    when $3::boolean and a.issue_executing then 'live_run'
    when a.issue_recent then 'recently_closed'
    when ($3::boolean and a.finalizations <> cardinality(a.run_ids)) or a.finalization_pending then 'pending_finalization'
    when a.lease_live then 'live_lease'
  end as reason
from input i left join assessed a on a.key = i.key`;

export type SessionRetentionAssessment = {
  reason: string | null; companyId: string | null; agentId: string | null; runIds: string[]; issueIds: string[];
  ownerIssueId: string | null; leaseIds: string[]; closedAt: number | null; resumable: boolean;
};

export async function assessSessionRetention(db: Db, sessions: Array<{ key: string; identity: { runId: string; normalizedSessionId: string; environmentLeaseId: string | null }; scopeDigest: string | null }>,
  options: { closedBefore: Date | "infinity"; checkpoint: boolean }): Promise<Map<string, SessionRetentionAssessment>> {
  if (sessions.length === 0) return new Map();
  const rows = await db.$client.unsafe<Array<{ key: string; company_id: string | null; agent_id: string | null; run_ids: string[] | null;
    issue_ids: string[] | null; owner_issue_id: string | null; lease_ids: string[] | null; closed_at: number | null; resumable: boolean; reason: string | null }>>(
    SESSION_RETENTION_BLOCKERS_SQL, [JSON.stringify(sessions.map(session => ({ key: session.key, run_id: session.identity.runId,
      session_id: session.identity.normalizedSessionId, scope_digest: session.scopeDigest, lease_id: session.identity.environmentLeaseId }))),
    options.closedBefore === "infinity" ? "infinity" : options.closedBefore.toISOString(), options.checkpoint]);
  return new Map(rows.map(row => [row.key, { reason: row.reason, companyId: row.company_id, agentId: row.agent_id,
    runIds: row.run_ids ?? [], issueIds: row.issue_ids ?? [], ownerIssueId: row.owner_issue_id, leaseIds: row.lease_ids ?? [],
    closedAt: row.closed_at === null ? null : Number(row.closed_at), resumable: row.resumable }]));
}
