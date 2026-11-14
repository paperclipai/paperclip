import { and, eq, getTableColumns, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { agents, decisionRetention, decisions, heartbeatRuns,
  issueApprovals, issueRecoveryActions, issueThreadInteractions, issues, approvals, type Db } from "@paperclipai/db";
import { evaluateAgentInvokability } from "./agent-invokability.js";
import { HUMAN_RECOVERY_OWNER_TYPES, ATTENTION_BUDGET_WARNING_PERCENT, ATTENTION_AGENT_ERROR_STATUS, collapsePendingConfirmationsToNewest, listFailedRunsWithNewerRun, loadNewestSettledConfirmationAt, readRunIssueId, requiresReviewAttention, terminalBlockerRequiresAttention } from "./attention-source-eligibility.js";
import { decisionRetentionService, DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { attentionIssueCondition } from "./issue-visibility.js";
import { RETRY_EXHAUSTION_MESSAGE_PREFIX } from "./heartbeat-run-events.js";
import { issueService } from "./issues.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isProspectiveBlockedTransition } from "./routable-blocked.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { AttentionRetentionScope } from "./retention-work-notifications.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;
const kinds = ["decision", "issue_thread_interaction", "recovery_action", "blocker_attention", "review",
  "failed_run", "budget_alert", "agent_error_alert"] as const;
type Kind = typeof kinds[number];
type Scope = AttentionRetentionScope;
type Candidate = { sourceKind: Kind; sourceId: string; companyId: string; activityAt: string; deadlineAt: number; issueId: string | null };
type Entry = Candidate & { id: string; dueAt: number; rootId: string; variant?: "owner" | "terminal" };
type Cursor = { sourceKind: string; sourceId: string };

type PageIssue = typeof issues.$inferSelect & { activityAt: string; deadlineAt: number;
  blockedActivityAt: string | null; blockedDeadlineAt: number | null };
type PageEvidence = {
  decisions: Map<string, { originIssueId: string }>;
  recoveries: Map<string, typeof issueRecoveryActions.$inferSelect>;
  runs: Map<string, typeof heartbeatRuns.$inferSelect>;
  agents: Set<string>;
  visibleIssues: Map<string, PageIssue>;
  newerRuns: Set<string>;
  deferredRoots: Set<string>;
  blockers: Awaited<ReturnType<ReturnType<typeof issueService>["listBlockerAttention"]>>;
};

const sourceTables: Record<Kind, SQL> = {
  decision: sql`decisions`, issue_thread_interaction: sql`issue_thread_interactions`,
  recovery_action: sql`issue_recovery_actions`, blocker_attention: sql`issues`, review: sql`issues`,
  failed_run: sql`heartbeat_runs`, budget_alert: sql`budget_incidents`, agent_error_alert: sql`agents`,
};

// Each source is one table read. `id` is the source row's uuid primary key and
// `source_id` is its text form. `where` holds the source's own eligibility.
type Source = { from: SQL; id: SQL; companyId: SQL; activityAt: SQL; issueId: SQL; where: SQL };
const sources: Record<Kind, Source> = {
  decision: { from: sql`decisions d`, id: sql`d.id`, companyId: sql`d.company_id`, activityAt: sql`d.updated_at`,
    issueId: sql`d.origin_issue_id::text`, where: sql`d.status = 'open'` },
  issue_thread_interaction: { from: sql`issue_thread_interactions i`, id: sql`i.id`, companyId: sql`i.company_id`,
    activityAt: sql`i.updated_at`, issueId: sql`i.issue_id::text`, where: sql`i.status = 'pending' and i.addressee_user_id is null` },
  recovery_action: { from: sql`issue_recovery_actions r`, id: sql`r.id`, companyId: sql`r.company_id`, activityAt: sql`r.updated_at`,
    issueId: sql`r.source_issue_id::text`,
    where: sql`r.status in ('active', 'escalated') and r.owner_type in (${sql.join(HUMAN_RECOVERY_OWNER_TYPES.map(owner => sql`${owner}`), sql`, `)})` },
  blocker_attention: { from: sql`issues i`, id: sql`i.id`, companyId: sql`i.company_id`, activityAt: sql`i.updated_at`,
    issueId: sql`i.id::text`, where: sql`i.status = 'blocked' and i.hidden_at is null and i.harness_kind is null` },
  review: { from: sql`issues i`, id: sql`i.id`, companyId: sql`i.company_id`, activityAt: sql`i.updated_at`,
    issueId: sql`i.id::text`, where: sql`i.status = 'in_review' and i.hidden_at is null and i.harness_kind is null` },
  // Keep the receipt filters as SQL literals. They must imply the predicate of
  // the partial index heartbeat_run_events_retry_exhausted_idx; a bound
  // parameter stops a generic prepared plan from using that index.
  failed_run: { from: sql`heartbeat_runs r`, id: sql`r.id`, companyId: sql`r.company_id`,
    activityAt: sql`coalesce(r.finished_at, r.updated_at, r.created_at)`,
    issueId: sql`coalesce(r.context_snapshot->>'issueId', r.context_snapshot->>'taskId')`,
    where: sql`r.status in ('failed', 'timed_out') and exists (
      select 1 from heartbeat_run_events e where e.company_id = r.company_id and e.run_id = r.id
        and e.event_type = 'lifecycle' and e.message like ${sql.raw(`'${RETRY_EXHAUSTION_MESSAGE_PREFIX}%'`)})` },
  budget_alert: { from: sql`budget_incidents b`, id: sql`b.id`, companyId: sql`b.company_id`, activityAt: sql`b.updated_at`,
    issueId: sql`null::text`, where: sql`b.status = 'open' and (b.threshold_type = 'hard' or (b.amount_limit > 0
      and round(b.amount_observed::numeric / b.amount_limit * 10000) / 100 >= ${ATTENTION_BUDGET_WARNING_PERCENT}))` },
  agent_error_alert: { from: sql`agents a`, id: sql`a.id`, companyId: sql`a.company_id`, activityAt: sql`a.updated_at`,
    issueId: sql`null::text`, where: sql`a.status = ${ATTENTION_AGENT_ERROR_STATUS}` },
};

const CANDIDATE_PAGE_SIZE = 100;
// PostgreSQL prints a uuid only in this form, so no other text equals a source_id.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The keyset orders by (source_kind, source_id). Each kind name differs from the
// others before its first underscore, so this code-unit order is also the order
// under linguistic collations. A test pins it against the database.
export const ATTENTION_RETENTION_KIND_ORDER: readonly Kind[] = [...kinds].sort();

/** One page of retention candidates in (source_kind, source_id) order.
 * Each kind is read in its own branch with every filter pushed into it and is
 * limited to one page, so a page reads at most one page per kind instead of
 * every candidate of every kind in every company. */
function candidateQuery(scope: Scope, cursor: Cursor | undefined, sourceId: string | undefined, issueIds: string[]): SQL | null {
  const selected = ATTENTION_RETENTION_KIND_ORDER.filter(kind => (!scope.sourceKind || scope.sourceKind === kind)
    && (!issueIds.length || !["budget_alert", "agent_error_alert"].includes(kind))
    && (!cursor || kind >= cursor.sourceKind));
  if (!selected.length) return null;
  if (sourceId !== undefined && !CANONICAL_UUID.test(sourceId)) return null;
  const branches = selected.map(kind => {
    const source = sources[kind];
    const conditions: SQL[] = [source.where, sql`company.status = 'active'`];
    if (scope.companyId != null) conditions.push(sql`${source.companyId} = ${scope.companyId}::uuid`);
    if (sourceId !== undefined) conditions.push(sql`${source.id} = ${sourceId}::uuid`);
    if (issueIds.length) conditions.push(sql`${source.issueId} in (${sql.join(issueIds.map(id => sql`${id}`), sql`, `)})`);
    // Blocker attention re-reads retention for its terminal source in eligible().
    if (kind !== "blocker_attention") conditions.push(sql`(retention.id is null or retention.keep = false) and retention.archived_at is null`);
    if (cursor?.sourceKind === kind) conditions.push(sql`${source.id}::text > ${cursor.sourceId}`);
    const retention = kind === "blocker_attention" ? sql`` : sql`left join decision_retention retention on retention.company_id = ${source.companyId}
      and retention.source_kind = ${kind} and retention.source_id = ${source.id}::text`;
    return sql`(select ${kind}::text as source_kind, ${source.id}::text as source_id, ${source.companyId} as company_id,
        ${source.activityAt} as activity_at, ${source.issueId} as issue_id
      from ${source.from} inner join companies company on company.id = ${source.companyId} ${retention}
      where ${sql.join(conditions, sql` and `)}
      order by ${source.id}::text limit ${CANDIDATE_PAGE_SIZE})`;
  });
  return sql`with source_candidates(source_kind, source_id, company_id, activity_at, issue_id) as (${sql.join(branches, sql` union all `)})
    select s.source_kind as "sourceKind", s.source_id as "sourceId", s.company_id as "companyId",
      s.issue_id as "issueId", s.activity_at::text as "activityAt", ceil(extract(epoch from s.activity_at) * 1000 + ${archiveDelay}) as "deadlineAt"
    from source_candidates s order by s.source_kind, s.source_id limit ${CANDIDATE_PAGE_SIZE}`;
}

export async function listAttentionRetentionCandidates(database: Db, scope: Scope = {}, cursor?: Cursor, sourceId?: string): Promise<Candidate[]> {
  const issueIds = scope.issueIds ?? (scope.issueId ? [scope.issueId] : []);
  const query = candidateQuery(scope, cursor, sourceId ?? scope.sourceId ?? undefined, issueIds);
  if (!query) return [];
  const rows = await database.execute(query) as unknown as Candidate[];
  return rows.map(row => ({ ...row, deadlineAt: Number(row.deadlineAt) }));
}

export function attentionRetentionService(db: Db) {
  const cursors = new Map<string, Cursor>();
  const candidates = listAttentionRetentionCandidates;

  async function visibleIssue(database: Db, companyId: string, issueId: string, conversations = false) {
    const [row] = await database.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId),
      attentionIssueCondition(conversations)));
    return row;
  }

  async function interactionEligibility(database: Db, candidates: Candidate[]) {
    const result = new Map<string, boolean>();
    const byCompany = new Map<string, string[]>();
    for (const candidate of candidates) {
      if (candidate.sourceKind !== "issue_thread_interaction") continue;
      const ids = byCompany.get(candidate.companyId) ?? [];
      ids.push(candidate.sourceId);
      byCompany.set(candidate.companyId, ids);
    }
    for (const [companyId, ids] of byCompany) {
      const rows = await database.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.id, ids),
        eq(issueThreadInteractions.status, "pending"), isNull(issueThreadInteractions.addresseeUserId)));
      if (!rows.length) continue;
      const visible = await database.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId),
        inArray(issues.id, rows.map(row => row.issueId)), attentionIssueCondition(true)));
      const visibleIds = new Set(visible.map(row => row.id));
      const roster = await database.select().from(agents).where(eq(agents.companyId, companyId));
      const boardAddressed = (row: typeof issueThreadInteractions.$inferSelect) => !row.addresseeAgentId
        || !evaluateAgentInvokability(roster.find(agent => agent.id === row.addresseeAgentId), roster).invokable;
      const confirmationIssueIds = rows.filter(row => row.kind === "request_confirmation").map(row => row.issueId);
      const siblings = confirmationIssueIds.length ? await database.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.issueId, confirmationIssueIds),
        eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.kind, "request_confirmation"),
        isNull(issueThreadInteractions.addresseeUserId))) : [];
      const newest = new Set(collapsePendingConfirmationsToNewest(siblings.filter(boardAddressed),
        await loadNewestSettledConfirmationAt(database, companyId, confirmationIssueIds)).map(row => row.id));
      for (const row of rows) result.set(row.id, visibleIds.has(row.issueId) && boardAddressed(row)
        && (row.kind !== "request_confirmation" || newest.has(row.id)));
    }
    return result;
  }

  async function reviewEligibility(database: Db, candidates: Candidate[]) {
    const result = new Map<string, boolean>();
    const byCompany = new Map<string, string[]>();
    for (const candidate of candidates) {
      if (candidate.sourceKind !== "review") continue;
      const ids = byCompany.get(candidate.companyId) ?? [];
      ids.push(candidate.sourceId);
      byCompany.set(candidate.companyId, ids);
    }
    for (const [companyId, ids] of byCompany) {
      const rows = await database.select().from(issues).where(and(eq(issues.companyId, companyId),
        inArray(issues.id, ids), attentionIssueCondition(false)));
      const pendingApprovals = await database.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
        .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId)).where(and(
          eq(issueApprovals.companyId, companyId), eq(approvals.companyId, companyId),
          inArray(issueApprovals.issueId, ids), eq(approvals.status, "pending")));
      const approved = new Set(pendingApprovals.map(row => row.issueId));
      const stalled = await issueService(database).listReviewAttention(companyId, rows);
      for (const row of rows) {
        const state = parseIssueExecutionState(row.executionState);
        result.set(row.id, requiresReviewAttention({
          hasHumanParticipant: state?.status === "pending" && state.currentParticipant?.type === "user",
          hasUserAssignee: Boolean(row.assigneeUserId), hasPendingApproval: approved.has(row.id),
          stalled: stalled.get(row.id)?.state === "stalled",
        }));
      }
    }
    return result;
  }

  async function pageEvidence(database: Db, candidates: Candidate[]) {
    const byCompany = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      if (!["decision", "recovery_action", "failed_run", "blocker_attention"].includes(candidate.sourceKind)) continue;
      const rows = byCompany.get(candidate.companyId) ?? [];
      rows.push(candidate);
      byCompany.set(candidate.companyId, rows);
    }
    const result = new Map<string, PageEvidence>();
    for (const [companyId, rows] of byCompany) {
      const ids = (kind: Kind) => rows.filter(row => row.sourceKind === kind).map(row => row.sourceId);
      const decisionIds = ids("decision"), recoveryIds = ids("recovery_action"), runIds = ids("failed_run"), blockerIds = ids("blocker_attention");
      const decisionRows = decisionIds.length ? await database.select({ id: decisions.id, originIssueId: decisions.originIssueId })
        .from(decisions).where(and(eq(decisions.companyId, companyId), inArray(decisions.id, decisionIds), eq(decisions.status, "open"))) : [];
      const recoveryRows = recoveryIds.length ? await database.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.id, recoveryIds))) : [];
      const runRows = runIds.length ? await database.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds))) : [];
      const runAgents = runRows.length ? await database.select({ id: agents.id }).from(agents).where(and(
        eq(agents.companyId, companyId), inArray(agents.id, [...new Set(runRows.map(row => row.agentId))]),
        sql`${agents.status} <> 'terminated'`)) : [];
      const readIssues = async (issueIds: string[]) => issueIds.length ? database.select({ ...getTableColumns(issues),
        activityAt: sql<string>`${issues.updatedAt}::text`,
        deadlineAt: sql<number>`ceil(extract(epoch from ${issues.updatedAt}) * 1000 + ${archiveDelay})`.mapWith(Number),
        blockedActivityAt: sql<string | null>`${issues.blockedTransitionAt}::text`,
        blockedDeadlineAt: sql<number | null>`ceil(extract(epoch from ${issues.blockedTransitionAt}) * 1000 + ${archiveDelay})`.mapWith(Number),
      }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, [...new Set(issueIds)]),
        attentionIssueCondition(false))) : [];
      const issueIds = [...blockerIds, ...decisionRows.map(row => row.originIssueId), ...recoveryRows.map(row => row.sourceIssueId),
        ...runRows.map(row => readRunIssueId(row.contextSnapshot))].filter((id): id is string => Boolean(id));
      const visibleRows = await readIssues(issueIds);
      const visible = new Map(visibleRows.map(row => [row.id, row]));
      const blockerRoots = visibleRows.filter(row => blockerIds.includes(row.id));
      const blockerBatch = blockerRoots.length ? await issueService(database).listBlockerAttentionBatch(companyId, blockerRoots)
        : { attention: new Map(), deferredRootIds: new Set<string>() };
      const blockers: PageEvidence["blockers"] = blockerBatch.attention;
      const terminalIds = [...blockers.values()].filter(terminalBlockerRequiresAttention)
        .map(attention => attention.terminalBlockerIssueId).filter((id): id is string => id != null && !visible.has(id));
      for (const row of await readIssues(terminalIds)) visible.set(row.id, row);
      result.set(companyId, {
        decisions: new Map(decisionRows.map(row => [row.id, row])), recoveries: new Map(recoveryRows.map(row => [row.id, row])),
        runs: new Map(runRows.map(row => [row.id, row])), agents: new Set(runAgents.map(row => row.id)), visibleIssues: visible,
        newerRuns: await listFailedRunsWithNewerRun(database, companyId,
          runRows.map(run => ({ ...run, issueId: readRunIssueId(run.contextSnapshot) }))), blockers, deferredRoots: blockerBatch.deferredRootIds,
      });
    }
    return result;
  }

  async function eligible(database: Db, candidate: Candidate, variant?: "owner" | "terminal", lock = false, reviewAttention?: Map<string, boolean>, interactionAttention?: Map<string, boolean>, evidence?: PageEvidence): Promise<Entry | null> {
    if (candidate.sourceKind === "blocker_attention" && variant === "terminal" && evidence?.deferredRoots.has(candidate.sourceId)) {
      return { ...candidate, rootId: candidate.sourceId, variant,
        id: `${candidate.sourceKind}:${candidate.sourceId}:terminal`, dueAt: Date.now() };
    }
    let sourceId = candidate.sourceId;
    let activityAt = candidate.activityAt;
    let dueAt = candidate.deadlineAt;
    if (candidate.sourceKind === "decision") {
      const row = evidence ? evidence.decisions.get(sourceId) : (await database.select({ originIssueId: decisions.originIssueId }).from(decisions)
        .where(and(eq(decisions.companyId, candidate.companyId), eq(decisions.id, sourceId), eq(decisions.status, "open"))))[0];
      if (!row || row.originIssueId && !(evidence ? evidence.visibleIssues.has(row.originIssueId)
        : await visibleIssue(database, candidate.companyId, row.originIssueId))) return null;
    } else if (candidate.sourceKind === "issue_thread_interaction") {
      const attention = interactionAttention ?? await interactionEligibility(database, [candidate]);
      if (!attention.get(sourceId)) return null;
    } else if (candidate.sourceKind === "recovery_action") {
      const row = evidence ? evidence.recoveries.get(sourceId) : (await database.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, candidate.companyId), eq(issueRecoveryActions.id, sourceId))))[0];
      if (!row || !(evidence ? evidence.visibleIssues.has(row.sourceIssueId)
        : await visibleIssue(database, candidate.companyId, row.sourceIssueId))) return null;
    } else if (candidate.sourceKind === "review") {
      const attention = reviewAttention ?? await reviewEligibility(database, [candidate]);
      if (!attention.get(sourceId)) return null;
    } else if (candidate.sourceKind === "blocker_attention") {
      const row = evidence ? evidence.visibleIssues.get(sourceId) : await visibleIssue(database, candidate.companyId, sourceId);
      if (!row) return null;
      if (variant === "owner") {
        if (row.unblockDescriptor?.owner !== "board" || !isProspectiveBlockedTransition(row)) return null;
        const activity = evidence ? { at: evidence.visibleIssues.get(sourceId)!.blockedActivityAt!, due: evidence.visibleIssues.get(sourceId)!.blockedDeadlineAt! } : (await database.execute(sql`select blocked_transition_at::text as at,
          ceil(extract(epoch from blocked_transition_at) * 1000 + ${archiveDelay}) as due from issues
          where company_id = ${candidate.companyId}::uuid and id = ${row.id}::uuid`) as unknown as Array<{ at: string; due: string }>)[0];
        activityAt = activity.at; dueAt = Number(activity.due);
      } else {
        const fresh = evidence ? undefined : await issueService(database).listBlockerAttentionBatch(candidate.companyId, [row]);
        // A bounded graph cannot establish absence of live work beyond its frontier.
        // Keep unknown roots visible; a later source change can revalidate them.
        if (fresh?.deferredRootIds.has(row.id)) return null;
        const attention = evidence ? evidence.blockers.get(row.id) : fresh!.attention.get(row.id);
        if (!terminalBlockerRequiresAttention(attention)) return null;
        sourceId = attention.terminalBlockerIssueId ?? row.id;
        if (lock && sourceId !== candidate.sourceId) await database.execute(sql`select id from issues
          where company_id = ${candidate.companyId}::uuid and id = ${sourceId}::uuid for update`);
        const terminal = evidence ? evidence.visibleIssues.get(sourceId) : await visibleIssue(database, candidate.companyId, sourceId);
        if (!terminal) return null;
        const activity = evidence ? { at: evidence.visibleIssues.get(sourceId)!.activityAt, due: evidence.visibleIssues.get(sourceId)!.deadlineAt } : (await database.execute(sql`select updated_at::text as at,
          ceil(extract(epoch from updated_at) * 1000 + ${archiveDelay}) as due from issues
          where company_id = ${candidate.companyId}::uuid and id = ${sourceId}::uuid`) as unknown as Array<{ at: string; due: string }>)[0];
        activityAt = activity.at; dueAt = Number(activity.due);
      }
      const [retention] = await database.select().from(decisionRetention).where(and(eq(decisionRetention.companyId, candidate.companyId),
        eq(decisionRetention.sourceKind, candidate.sourceKind), eq(decisionRetention.sourceId, sourceId)));
      if (retention?.keep || retention?.archivedAt) return null;
    } else if (candidate.sourceKind === "failed_run") {
      const run = evidence ? evidence.runs.get(sourceId) : (await database.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId), eq(heartbeatRuns.id, sourceId))))[0];
      if (!run) return null;
      const agent = evidence ? evidence.agents.has(run.agentId) : (await database.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, candidate.companyId),
        eq(agents.id, run.agentId), sql`${agents.status} <> 'terminated'`)))[0];
      const issueId = readRunIssueId(run.contextSnapshot);
      if (!agent || issueId && !(evidence ? evidence.visibleIssues.has(issueId)
        : await visibleIssue(database, candidate.companyId, issueId))) return null;
      if ((evidence ? evidence.newerRuns : await listFailedRunsWithNewerRun(database, candidate.companyId, [{ ...run, issueId }])).has(run.id)) return null;
    }
    return { ...candidate, sourceId, activityAt, rootId: candidate.sourceId, variant,
      id: `${candidate.sourceKind}:${candidate.sourceId}:${variant ?? "source"}`, dueAt };
  }

  async function load(scope?: Scope, signal?: AbortSignal) {
    const key = JSON.stringify(scope ?? {});
    const rows = await candidates(db, scope, cursors.get(key));
    const entries: Entry[] = [];
    const reviews = await reviewEligibility(db, rows);
    const interactions = await interactionEligibility(db, rows);
    const evidence = await pageEvidence(db, rows);
    for (const row of rows) {
      if (signal?.aborted) return { rows: null, complete: true };
      for (const variant of row.sourceKind === "blocker_attention" ? ["owner", "terminal"] as const : [undefined]) {
        const entry = await eligible(db, row, variant, false, reviews, interactions, evidence.get(row.companyId));
        if (entry) entries.push(entry);
      }
    }
    if (rows.length === CANDIDATE_PAGE_SIZE) {
      const last = rows[rows.length - 1]!;
      cursors.set(key, { sourceKind: last.sourceKind, sourceId: last.sourceId });
    } else cursors.delete(key);
    return { rows: entries, complete: rows.length < CANDIDATE_PAGE_SIZE };
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
      && (!scope?.sourceId || scope.sourceId === entry.sourceId)
      && (!scope?.issueId || scope.issueId === entry.issueId)
      && (!scope?.issueIds?.length || entry.issueId !== null && scope.issueIds.includes(entry.issueId)),
    load: service.load, check: service.check,
  }, canRun);
}
