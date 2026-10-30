import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { agents, decisionRetention, decisions, heartbeatRuns,
  issueApprovals, issueRecoveryActions, issueThreadInteractions, issues, approvals, type Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { collapsePendingConfirmationsToNewest, listFailedRunsWithNewerRun, readRunIssueId, requiresReviewAttention, terminalBlockerRequiresAttention } from "./attention-source-eligibility.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { attentionIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isProspectiveBlockedTransition } from "./routable-blocked.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;
const kinds = ["decision", "issue_thread_interaction", "recovery_action", "blocker_attention", "review",
  "failed_run", "budget_alert", "agent_error_alert"] as const;
type Kind = typeof kinds[number];
type Scope = { companyId?: string; sourceKind?: AttentionSourceKind; sourceId?: string };
type Candidate = { sourceKind: Kind; sourceId: string; companyId: string; activityAt: string; deadlineAt: number };
type Entry = Candidate & { id: string; dueAt: number; rootId: string; variant?: "owner" | "terminal" };
type Cursor = { sourceKind: string; sourceId: string };

const sourceTables: Record<Kind, SQL> = {
  decision: sql`decisions`, issue_thread_interaction: sql`issue_thread_interactions`,
  recovery_action: sql`issue_recovery_actions`, blocker_attention: sql`issues`, review: sql`issues`,
  failed_run: sql`heartbeat_runs`, budget_alert: sql`budget_incidents`, agent_error_alert: sql`agents`,
};

const sources: Record<Kind, SQL> = {
  decision: sql`select 'decision' as source_kind, d.id::text as source_id, d.company_id, d.updated_at as activity_at
    from decisions d where d.status = 'open'`,
  issue_thread_interaction: sql`select 'issue_thread_interaction', i.id::text, i.company_id, i.updated_at
    from issue_thread_interactions i where i.status = 'pending' and i.addressee_user_id is null`,
  recovery_action: sql`select 'recovery_action', r.id::text, r.company_id, r.updated_at
    from issue_recovery_actions r where r.status in ('active', 'escalated') and r.owner_type in ('user', 'board')`,
  blocker_attention: sql`select 'blocker_attention', i.id::text, i.company_id, i.updated_at
    from issues i where i.status = 'blocked' and i.hidden_at is null and i.harness_kind is null`,
  review: sql`select 'review', i.id::text, i.company_id, i.updated_at
    from issues i where i.status = 'in_review' and i.hidden_at is null and i.harness_kind is null`,
  failed_run: sql`select 'failed_run', r.id::text, r.company_id, coalesce(r.finished_at, r.updated_at, r.created_at)
    from heartbeat_runs r where r.status in ('failed', 'timed_out') and exists (
      select 1 from heartbeat_run_events e where e.run_id = r.id and e.company_id = r.company_id
        and e.event_type = 'lifecycle' and e.message like 'Bounded retry exhausted%')`,
  budget_alert: sql`select 'budget_alert', b.id::text, b.company_id, b.updated_at from budget_incidents b
    where b.status = 'open' and (b.threshold_type = 'hard' or (b.amount_limit > 0
      and round(b.amount_observed::numeric / b.amount_limit * 10000) / 100 >= 85))`,
  agent_error_alert: sql`select 'agent_error_alert', a.id::text, a.company_id, a.updated_at from agents a where a.status = 'error'`,
};

export function attentionRetentionService(db: Db) {
  const cursors = new Map<string, Cursor>();
  async function candidates(database: Db, scope: Scope = {}, cursor?: Cursor, sourceId?: string): Promise<Candidate[]> {
    const selected = kinds.filter(kind => !scope.sourceKind || scope.sourceKind === kind);
    if (!selected.length) return [];
    const rows = await database.execute(sql`with source_candidates(source_kind, source_id, company_id, activity_at) as (${sql.join(selected.map(kind => sources[kind]), sql` union all `)})
      select s.source_kind as "sourceKind", s.source_id as "sourceId", s.company_id as "companyId",
        s.activity_at::text as "activityAt", ceil(extract(epoch from s.activity_at) * 1000 + ${archiveDelay}) as "deadlineAt"
      from source_candidates s inner join companies c on c.id = s.company_id
      left join decision_retention r on r.company_id = s.company_id and r.source_kind = s.source_kind and r.source_id = s.source_id
      where c.status = 'active'
        and (${scope.companyId ?? null}::uuid is null or s.company_id = ${scope.companyId ?? null}::uuid)
        and (${sourceId ?? scope.sourceId ?? null}::text is null or s.source_id = ${sourceId ?? scope.sourceId ?? null})
        and (s.source_kind = 'blocker_attention' or ((r.id is null or r.keep = false) and r.archived_at is null))
        ${cursor ? sql`and (s.source_kind, s.source_id) > (${cursor.sourceKind}, ${cursor.sourceId})` : sql``}
      order by s.source_kind, s.source_id limit 100`) as unknown as Candidate[];
    return rows.map(row => ({ ...row, deadlineAt: Number(row.deadlineAt) }));
  }

  async function visibleIssue(database: Db, companyId: string, issueId: string, conversations = false) {
    const [row] = await database.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId),
      attentionIssueCondition(conversations)));
    return row;
  }

  async function eligible(database: Db, candidate: Candidate, variant?: "owner" | "terminal", lock = false): Promise<Entry | null> {
    let sourceId = candidate.sourceId;
    let activityAt = candidate.activityAt;
    let dueAt = candidate.deadlineAt;
    if (candidate.sourceKind === "decision") {
      const [row] = await database.select({ originIssueId: decisions.originIssueId }).from(decisions)
        .where(and(eq(decisions.companyId, candidate.companyId), eq(decisions.id, sourceId), eq(decisions.status, "open")));
      if (!row || row.originIssueId && !await visibleIssue(database, candidate.companyId, row.originIssueId)) return null;
    } else if (candidate.sourceKind === "issue_thread_interaction") {
      const [row] = await database.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, candidate.companyId), eq(issueThreadInteractions.id, sourceId),
        eq(issueThreadInteractions.status, "pending"), isNull(issueThreadInteractions.addresseeUserId)));
      if (!row || !await visibleIssue(database, candidate.companyId, row.issueId, true)) return null;
      const roster = row.addresseeAgentId ? await database.select().from(agents).where(eq(agents.companyId, candidate.companyId)) : [];
      if (row.addresseeAgentId && evaluateAgentInvokability(roster.find(agent => agent.id === row.addresseeAgentId), roster).invokable) return null;
      if (row.kind === "request_confirmation") {
        const siblings = await database.select().from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.companyId, candidate.companyId), eq(issueThreadInteractions.issueId, row.issueId),
          eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.kind, "request_confirmation"),
          isNull(issueThreadInteractions.addresseeUserId)));
        const companyAgents = roster.length ? roster : await database.select().from(agents).where(eq(agents.companyId, candidate.companyId));
        const board = siblings.filter(sibling => !sibling.addresseeAgentId
          || !evaluateAgentInvokability(companyAgents.find(agent => agent.id === sibling.addresseeAgentId), companyAgents).invokable);
        if (!collapsePendingConfirmationsToNewest(board).some(sibling => sibling.id === sourceId)) return null;
      }
    } else if (candidate.sourceKind === "recovery_action") {
      const [row] = await database.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, candidate.companyId), eq(issueRecoveryActions.id, sourceId)));
      if (!row || !await visibleIssue(database, candidate.companyId, row.sourceIssueId)) return null;
    } else if (candidate.sourceKind === "review") {
      const row = await visibleIssue(database, candidate.companyId, sourceId);
      if (!row) return null;
      const state = parseIssueExecutionState(row.executionState);
      const [approval] = await database.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
        .where(and(eq(issueApprovals.companyId, candidate.companyId), eq(approvals.companyId, candidate.companyId),
          eq(issueApprovals.issueId, sourceId), eq(approvals.status, "pending"))).limit(1);
      if (!requiresReviewAttention({ hasHumanParticipant: state?.status === "pending" && state.currentParticipant?.type === "user",
        hasUserAssignee: Boolean(row.assigneeUserId), hasPendingApproval: Boolean(approval), stalled: false })) {
        const attention = await issueService(database).listReviewAttention(candidate.companyId, [row]);
        if (!requiresReviewAttention({ hasHumanParticipant: false, hasUserAssignee: false, hasPendingApproval: false,
          stalled: attention.get(sourceId)?.state === "stalled" })) return null;
      }
    } else if (candidate.sourceKind === "blocker_attention") {
      const row = await visibleIssue(database, candidate.companyId, sourceId);
      if (!row) return null;
      if (variant === "owner") {
        if (row.unblockDescriptor?.owner !== "board" || !isProspectiveBlockedTransition(row)) return null;
        const [activity] = await database.execute(sql`select blocked_transition_at::text as at,
          ceil(extract(epoch from blocked_transition_at) * 1000 + ${archiveDelay}) as due from issues
          where company_id = ${candidate.companyId}::uuid and id = ${row.id}::uuid`) as unknown as Array<{ at: string; due: string }>;
        activityAt = activity.at; dueAt = Number(activity.due);
      } else {
        const attention = (await issueService(database).listBlockerAttention(candidate.companyId, [row])).get(row.id);
        if (!terminalBlockerRequiresAttention(attention)) return null;
        sourceId = attention.terminalBlockerIssueId ?? row.id;
        if (lock && sourceId !== candidate.sourceId) await database.execute(sql`select id from issues
          where company_id = ${candidate.companyId}::uuid and id = ${sourceId}::uuid for update`);
        const terminal = await visibleIssue(database, candidate.companyId, sourceId);
        if (!terminal) return null;
        const [activity] = await database.execute(sql`select updated_at::text as at,
          ceil(extract(epoch from updated_at) * 1000 + ${archiveDelay}) as due from issues
          where company_id = ${candidate.companyId}::uuid and id = ${sourceId}::uuid`) as unknown as Array<{ at: string; due: string }>;
        activityAt = activity.at; dueAt = Number(activity.due);
      }
      const [retention] = await database.select().from(decisionRetention).where(and(eq(decisionRetention.companyId, candidate.companyId),
        eq(decisionRetention.sourceKind, candidate.sourceKind), eq(decisionRetention.sourceId, sourceId)));
      if (retention?.keep || retention?.archivedAt) return null;
    } else if (candidate.sourceKind === "failed_run") {
      const [run] = await database.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, sourceId)));
      if (!run) return null;
      const [agent] = await database.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, candidate.companyId),
        eq(agents.id, run.agentId), sql`${agents.status} <> 'terminated'`));
      const issueId = readRunIssueId(run.contextSnapshot);
      if (!agent || issueId && !await visibleIssue(database, candidate.companyId, issueId)) return null;
      if ((await listFailedRunsWithNewerRun(database, candidate.companyId, [{ ...run, issueId }])).has(run.id)) return null;
    }
    return { ...candidate, sourceId, activityAt, rootId: candidate.sourceId, variant,
      id: `${candidate.sourceKind}:${candidate.sourceId}:${variant ?? "source"}`, dueAt };
  }

  async function load(scope?: Scope, signal?: AbortSignal) {
    const key = JSON.stringify(scope ?? {});
    const rows = await candidates(db, scope, cursors.get(key));
    const entries: Entry[] = [];
    for (const row of rows) {
      if (signal?.aborted) return { rows: null, complete: true };
      for (const variant of row.sourceKind === "blocker_attention" ? ["owner", "terminal"] as const : [undefined]) {
        const entry = await eligible(db, row, variant);
        if (entry) entries.push(entry);
      }
    }
    if (rows.length === 100) {
      const last = rows[rows.length - 1]!;
      cursors.set(key, { sourceKind: last.sourceKind, sourceId: last.sourceId });
    } else cursors.delete(key);
    return { rows: entries, complete: rows.length < 100 };
  }

  async function check(entry: Entry) {
    return db.transaction(async transaction => {
      const database = transaction as unknown as Db;
      await database.execute(sql`select id from ${sourceTables[entry.sourceKind]}
        where company_id = ${entry.companyId}::uuid and id = ${entry.rootId}::uuid for update`);
      const [candidate] = await candidates(database, { companyId: entry.companyId, sourceKind: entry.sourceKind }, undefined, entry.rootId);
      if (!candidate) return null;
      const current = await eligible(database, candidate, entry.variant, true);
      if (!current || current.dueAt > Date.now()) return current;
      const retention = decisionRetentionService(database);
      const item = { sourceKind: current.sourceKind, subject: { id: current.sourceId }, activityAt: current.activityAt };
      const state = (await retention.syncItems(current.companyId, [item])).get(`${current.sourceKind}:${current.sourceId}`)!;
      await retention.autoArchive({ companyId: current.companyId, items: [{ ...item,
        keep: state.keep, archivedAt: state.archivedAt?.toISOString() ?? null, retentionVersion: state.version }] });
      return null;
    });
  }
  return { load, check };
}

export function registerAttentionRetentionWork(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof attentionRetentionService>, canRun: () => boolean) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.attentionRetention,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as Scope,
    matches: (entry, scope) => (!scope?.companyId || scope.companyId === entry.companyId)
      && (!scope?.sourceKind || scope.sourceKind === entry.sourceKind)
      && (!scope?.sourceId || scope.sourceId === entry.sourceId),
    load: service.load, check: service.check,
  }, canRun);
}
