import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { activityLog, agents, approvals, budgetIncidents, companies, decisions, decisionTargetIssues, issues, issueThreadInteractions, projects, type Db } from "@paperclipai/db";
import { ATTENTION_RECEIPT_OUTCOME_TEXT, type DecisionHistoryAction, type DecisionHistoryItem, type DecisionHistoryPage, type DecisionHistoryQuery, type DecisionHistoryResultOutcome } from "@paperclipai/shared";
import { approvalReadSqlCondition, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { badRequest } from "../errors.js";
import { firstApprovalIssueId } from "./approval-visibility.js";
import { approvalTitle, MAX_INSTIGATOR_CHAIN_DEPTH } from "./attention.js";
import { readAttentionHandledDetails } from "./attention-receipts.js";
import { humanCreatedIssueCondition } from "./issue-participation.js";

type HistoryOptions = DecisionHistoryQuery & { actor: AuthorizationActor; userId: string; issueIds?: string[] };
type Cursor = { at: string; id: string; sort: "newest" | "oldest" };

export function itemVerdictsHistoryLabel(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("outcome" in result) || result.outcome !== "resolved"
    || !("items" in result) || !Array.isArray(result.items)) return null;
  const counts = { approve: 0, reject: 0, defer: 0 };
  for (const item of result.items) {
    if (item?.verdict === "approve" || item?.verdict === "reject" || item?.verdict === "defer") counts[item.verdict as keyof typeof counts]++;
  }
  return [counts.approve ? `${counts.approve} approved` : null, counts.reject ? `${counts.reject} rejected` : null,
    counts.defer ? `${counts.defer} deferred` : null].filter(Boolean).join(" · ") || "Review recorded";
}

function readRecordValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value) && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * History labels by outcome. An interaction's `result.outcome` is more
 * specific than its status: a withdrawn, skipped or task-closed card is stored
 * as `cancelled` or `expired` (PAP-749 plan §2, Data and §3). A withdraw by a
 * person reads `withdrawn_by_user`; one by the agent itself stays `withdrawn`.
 */
const HISTORY_OUTCOME_LABELS: Record<string, string> = {
  accepted: "Approved", rejected: "Changes requested", answered: "Answers recorded", cancelled: "Cancelled",
  expired: "Expired", failed: "Failed", stale_target: "Superseded", superseded_by_newer_request: "Superseded",
  superseded_by_comment: "Answered in task", withdrawn: "Withdrawn", withdrawn_by_user: "Withdrawn by user",
  skipped: "Skipped", issue_closed: "Closed with task",
};

/** Approval labels by status (PAP-749 plan §3: approvals in history). */
const APPROVAL_OUTCOME_LABELS: Record<string, string> = {
  approved: "Approved", rejected: "Rejected", revision_requested: "Revision requested", cancelled: "Cancelled",
};

/** History outcome filters that read `result.outcome`, not the status. */
const RESULT_OUTCOME_FILTERS = new Set(["withdrawn", "withdrawn_by_user", "skipped", "issue_closed"]);
const RESULT_OUTCOMES: ReadonlySet<string> = new Set<DecisionHistoryResultOutcome>(["withdrawn", "skipped", "issue_closed"]);

/** The specific close an interaction result records, for the history filters and UI. */
export function interactionHistoryResultOutcome(result: unknown): DecisionHistoryResultOutcome | null {
  const outcome = readRecordValue(result, "outcome");
  return typeof outcome === "string" && RESULT_OUTCOMES.has(outcome) ? outcome as DecisionHistoryResultOutcome : null;
}

/**
 * A budget hard stop's approval closes through the budget card: Raise limit
 * approves it and Keep paused rejects it (`budgets.resolveIncident`).
 */
const BUDGET_APPROVAL_ACTIONS: Record<string, DecisionHistoryAction["outcome"]> = {
  approved: "limit_raised", rejected: "kept_paused",
};
const APPROVAL_ACTIONS: Record<string, DecisionHistoryAction["outcome"]> = {
  approved: "approved", rejected: "rejected", revision_requested: "revision_requested", cancelled: "withdrawn",
};

/** An approval's history label: a cancel by a person is a withdraw (PAP-749 plan §2, Rule 6). */
export function approvalHistoryLabel(row: { status: string; decidedByUserId: string | null; type?: string }) {
  if (row.status === "cancelled" && row.decidedByUserId) return HISTORY_OUTCOME_LABELS.withdrawn_by_user!;
  const budgetAction = row.type === "budget_override_required" ? BUDGET_APPROVAL_ACTIONS[row.status] : undefined;
  if (budgetAction) return ATTENTION_RECEIPT_OUTCOME_TEXT[budgetAction];
  return APPROVAL_OUTCOME_LABELS[row.status] ?? "Decision recorded";
}

/**
 * What the person did, in the receipt's words (PAP-767): the UI renders
 * "Kept paused by @dotta" from this, so a history row and the receipt for the
 * same action read the same verb. `null` when no person acted.
 */
export function approvalHistoryAction(row: { status: string; decidedByUserId: string | null; type: string }): DecisionHistoryAction | null {
  if (!row.decidedByUserId) return null;
  const budgetAction = row.type === "budget_override_required" ? BUDGET_APPROVAL_ACTIONS[row.status] : undefined;
  if (budgetAction) return { outcome: budgetAction, detail: null };
  const outcome = APPROVAL_ACTIONS[row.status];
  return outcome ? { outcome, detail: null } : null;
}

export function interactionHistoryAction(row: { kind: string; status: string; result: unknown; resolvedByUserId: string | null }): DecisionHistoryAction | null {
  if (!row.resolvedByUserId) return null;
  const resultOutcome = interactionHistoryResultOutcome(row.result);
  if (resultOutcome === "withdrawn" || resultOutcome === "skipped") return { outcome: resultOutcome, detail: null };
  if (resultOutcome) return null;
  if (row.status === "accepted") return { outcome: "approved", detail: null };
  if (row.status === "rejected") return { outcome: "changes_requested", detail: null };
  if (row.status === "answered") {
    return { outcome: "answered", detail: row.kind === "request_item_verdicts" ? itemVerdictsHistoryLabel(row.result) : null };
  }
  return null;
}

export function decisionHistoryAction(row: { status: string; resolvedByUserId: string | null; chosenLabel: string | null }): DecisionHistoryAction | null {
  if (!row.resolvedByUserId) return null;
  if (row.status === "decided") return { outcome: "decided", detail: row.chosenLabel };
  if (row.status === "cancelled") return { outcome: "withdrawn", detail: null };
  return null;
}


export function interactionHistoryLabel(row: { kind: string; status: string; result: unknown; resolvedByUserId: string | null }) {
  const resultOutcome = readRecordValue(row.result, "outcome");
  const outcome = typeof resultOutcome === "string" ? resultOutcome : row.status;
  const key = outcome === "withdrawn" && row.resolvedByUserId ? "withdrawn_by_user" : outcome;
  return (row.kind === "request_item_verdicts" ? itemVerdictsHistoryLabel(row.result) : null)
    ?? HISTORY_OUTCOME_LABELS[key] ?? HISTORY_OUTCOME_LABELS[row.status] ?? "Decision recorded";
}

/** The reason a person gave when they withdrew, skipped or cancelled the request. */
export function interactionHistoryReason(result: unknown): string | null {
  const reason = readRecordValue(result, "reason") ?? readRecordValue(result, "cancellationReason");
  return typeof reason === "string" && reason.trim() ? reason : null;
}

export function decodeDecisionHistoryCursor(value: string | undefined, sort: Cursor["sort"]): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed.sort !== sort || typeof parsed.id !== "string" || !/^(decision|issue_thread_interaction|approval):[0-9a-f-]{36}$/i.test(parsed.id)
      || typeof parsed.at !== "string" || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return parsed;
  } catch { throw badRequest("Invalid decision history cursor"); }
}

export function decisionHistoryTarget(payload: unknown): DecisionHistoryItem["target"] {
  const target = (payload as { target?: Record<string, unknown> } | null)?.target;
  if (target?.type === "issue_document" && typeof target.key === "string" && typeof target.revisionId === "string") {
    return { kind: "issue_document", key: target.key, revisionId: target.revisionId,
      ...(typeof target.issueId === "string" && target.issueId ? { issueId: target.issueId } : {}) };
  }
  if (target?.type === "issue_attachment" && typeof target.attachmentId === "string") {
    return { kind: "issue_attachment", attachmentId: target.attachmentId };
  }
  return null;
}

/** Never follows a custom URL or silently replaces the reviewed revision with latest. */
export function decisionHistoryHref(prefix: string, issueRef: string, sourceKind: DecisionHistoryItem["sourceKind"], sourceId: string, target: DecisionHistoryItem["target"]) {
  const path = `/${encodeURIComponent(prefix)}/issues/${encodeURIComponent(issueRef)}`;
  const anchor = sourceKind === "issue_thread_interaction" ? `interaction-${sourceId}` : `decision-${sourceId}`;
  if (target?.kind === "issue_document") {
    return `${path}#document-${encodeURIComponent(target.key)}&revision=${encodeURIComponent(target.revisionId)}&${sourceKind === "issue_thread_interaction" ? "interaction" : "decision"}=${encodeURIComponent(sourceId)}${target.issueId ? `&documentIssue=${encodeURIComponent(target.issueId)}` : ""}`;
  }
  if (target?.kind === "issue_attachment") return `${path}#${anchor}&attachment=${encodeURIComponent(target.attachmentId)}`;
  return `${path}#${anchor}`;
}

export function pageDecisionHistory(items: DecisionHistoryItem[], limit: number, sort: Cursor["sort"]): DecisionHistoryPage {
  const sorted = [...items].sort((a, b) => {
    const delta = Date.parse(a.resolvedAt) - Date.parse(b.resolvedAt) || a.id.localeCompare(b.id);
    return sort === "oldest" ? delta : -delta;
  });
  const page = sorted.slice(0, limit);
  const last = page.at(-1);
  return { items: page, nextCursor: sorted.length > limit && last
    ? Buffer.from(JSON.stringify({ at: last.resolvedAt, id: last.id, sort })).toString("base64url") : null };
}

type HistorySourceId = SQL | typeof decisions.id | typeof issueThreadInteractions.id | typeof approvals.id;

/**
 * A receipt on an action's activity entry that names this source and matches
 * `person` (PAP-749 plan §6). Receipts exist only when the actor was not the
 * card's person, so they record "handled for" and "handled by" across people.
 */
function receiptSourceCondition(companyId: string, person: SQL, sourceKind: DecisionHistoryItem["sourceKind"], sourceId: HistorySourceId) {
  // A budget hard stop is answered on its budget card, so the receipt names
  // the incident; history lists the incident's approval (PAP-767).
  const budgetReceipt = sourceKind === "approval"
    ? sql`or (${activityLog.details} -> 'receipt' ->> 'sourceKind' = 'budget_alert'
        and ${activityLog.details} -> 'receipt' ->> 'sourceId' in (
          select ${budgetIncidents.id}::text from ${budgetIncidents}
          where ${budgetIncidents.companyId} = ${companyId} and ${budgetIncidents.approvalId} = ${sourceId}))`
    : sql``;
  return sql<boolean>`exists (
    select 1 from ${activityLog}
    where ${activityLog.companyId} = ${companyId}
      and ${person}
      and ((${activityLog.details} -> 'receipt' ->> 'sourceKind' = ${sourceKind}
        and ${activityLog.details} -> 'receipt' ->> 'sourceId' = ${sourceId}::text)
        ${budgetReceipt})
  )`;
}

/**
 * "Handled for me" (PAP-749 plan §6): a different person answered, withdrew
 * or transferred this card while it was for `userId`.
 */
function handledForUserSourceCondition(companyId: string, userId: string, sourceKind: DecisionHistoryItem["sourceKind"], sourceId: HistorySourceId) {
  return receiptSourceCondition(companyId, sql`(${activityLog.details} ->> 'handledForUserId') = ${userId}`, sourceKind, sourceId);
}

/** `userId` handled this card for someone else, or someone else handled it for `userId` (a transfer included). */
function handledByOrForUserSourceCondition(companyId: string, userId: string, sourceKind: DecisionHistoryItem["sourceKind"], sourceId: HistorySourceId) {
  return receiptSourceCondition(companyId, sql`((${activityLog.details} ->> 'handledForUserId') = ${userId}
    or (${activityLog.details} -> 'receipt' ->> 'actorUserId') = ${userId})`, sourceKind, sourceId);
}

/**
 * The tasks `userId` instigated: the ones they created by hand, and the agent
 * or routine work under them up to the next hand-made task, the same walk as
 * the live audience (`resolveIssueAudienceContextMap`). One walk down from the
 * person's own tasks over the (company, parent) index, not one per row.
 */
function instigatedIssueIdsSql(companyId: string, userId: string) {
  const root = alias(issues, "history_instigator_root");
  const child = alias(issues, "history_instigator_child");
  return sql`with recursive history_instigated(id, depth) as (
      select ${root.id}, 0 from ${issues} ${sql.identifier("history_instigator_root")}
      where ${root.companyId} = ${companyId} and ${root.createdByUserId} = ${userId} and ${humanCreatedIssueCondition(root)}
      union all
      select ${child.id}, history_instigated.depth + 1 from ${issues} ${sql.identifier("history_instigator_child")}
      inner join history_instigated on ${child.parentId} = history_instigated.id
      where ${child.companyId} = ${companyId} and not ${humanCreatedIssueCondition(child)}
        and history_instigated.depth < ${MAX_INSTIGATOR_CHAIN_DEPTH}
    ) select id from history_instigated`;
}

/**
 * The card's task makes it `userId`'s (PAP-749 plan §1, Rule 2): the chat
 * user, else the human assignee, else the instigator. Read from the task as it
 * is now. Escalation owners are left out: a card that reached its project's
 * or the company's decision owner is in their history once they handle it.
 */
function issueAudienceIsUserCondition(companyId: string, userId: string) {
  return or(
    eq(issues.conversationUserId, userId),
    and(isNull(issues.conversationUserId), eq(issues.assigneeUserId, userId)),
    and(isNull(issues.conversationUserId), isNull(issues.assigneeUserId),
      sql`${issues.id} in (${instigatedIssueIdsSql(companyId, userId)})`),
  );
}

/**
 * The person each answered card was for, when someone else answered it
 * ("Answered by @x for @y"). A transfer is not the answer, so it is skipped.
 */
async function handledForBySource(db: Db, companyId: string, items: Array<Pick<DecisionHistoryItem, "sourceKind" | "sourceId">>) {
  const result = new Map<string, string>();
  if (items.length === 0) return result;
  // A budget hard stop's receipt names the incident, not its approval (PAP-767).
  const approvalIds = items.filter((item) => item.sourceKind === "approval").map((item) => item.sourceId);
  const incidentRows = approvalIds.length === 0 ? [] : await db
    .select({ id: budgetIncidents.id, approvalId: budgetIncidents.approvalId })
    .from(budgetIncidents)
    .where(and(eq(budgetIncidents.companyId, companyId), inArray(budgetIncidents.approvalId, approvalIds)));
  const approvalByIncident = new Map(incidentRows.map((row) => [row.id, row.approvalId!]));
  const sourceIds = [...items.map((item) => item.sourceId), ...approvalByIncident.keys()];
  const rows = await db
    .select({ details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      sql`(${activityLog.details} ->> 'handledForUserId') IS NOT NULL`,
      inArray(sql<string>`${activityLog.details} -> 'receipt' ->> 'sourceId'`, sourceIds),
    ))
    .orderBy(desc(activityLog.createdAt));
  for (const row of rows) {
    const receipt = readAttentionHandledDetails(row.details);
    const userId = (row.details as Record<string, unknown> | null)?.handledForUserId;
    if (!receipt || receipt.outcome === "transferred" || typeof userId !== "string") continue;
    const budgetApprovalId = receipt.sourceKind === "budget_alert" ? approvalByIncident.get(receipt.sourceId) : undefined;
    const key = budgetApprovalId ? `approval:${budgetApprovalId}` : `${receipt.sourceKind}:${receipt.sourceId}`;
    if (!result.has(key)) result.set(key, userId);
  }
  return result;
}

export function decisionHistoryService(db: Db) {
  return { async list(companyId: string, options: HistoryOptions): Promise<DecisionHistoryPage> {
    if (options.issueIds?.length === 0) return { items: [], nextCursor: null };
    const limit = Math.max(1, Math.min(options.limit ?? 40, 100));
    const sort = options.sort ?? "newest";
    const cursor = decodeDecisionHistoryCursor(options.cursor, sort);
    const since = options.since ? new Date(options.since) : null;
    if (since && !Number.isFinite(since.getTime())) throw badRequest("Invalid decision history date");
    const readable = await issueReadSqlCondition(db, options.actor);
    const readableIssues = db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), readable));
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
    if (!company) return { items: [], nextCursor: null };
    // Cursor timestamps use the JSON/Date millisecond precision. Normalize SQL
    // ordering to that same precision; the canonical source key breaks ties.
    const interactionTime = sql<Date>`date_trunc('milliseconds', ${issueThreadInteractions.resolvedAt})`;
    const decisionTime = sql<Date>`date_trunc('milliseconds', coalesce(${decisions.decidedAt}, ${decisions.updatedAt}))`;
    const approvalTime = sql<Date>`date_trunc('milliseconds', coalesce(${approvals.decidedAt}, ${approvals.updatedAt}))`;
    const interactionKey = sql<string>`'issue_thread_interaction:' || ${issueThreadInteractions.id}`;
    const decisionKey = sql<string>`'decision:' || ${decisions.id}`;
    const approvalKey = sql<string>`'approval:' || ${approvals.id}`;
    // Same fallback as the card title (`approvalTitle`), so search finds what the person sees.
    const approvalTitleSql = sql<string>`coalesce(nullif(btrim(${approvals.payload}->>'title'), ''), nullif(btrim(${approvals.payload}->>'summary'), ''), replace(${approvals.type}, '_', ' '))`;
    const approvalIssueId = firstApprovalIssueId();
    const completedItemReview = and(eq(issueThreadInteractions.kind, "request_item_verdicts"),
      eq(issueThreadInteractions.status, "answered"), sql`${issueThreadInteractions.result}->>'outcome' = 'resolved'`);
    // Item reviews retain their canonical answered status, but outcome filters
    // describe the recorded verdicts. A mixed review can match both outcomes.
    const resultOutcomeFilter = options.outcome && RESULT_OUTCOME_FILTERS.has(options.outcome)
      ? options.outcome === "withdrawn_by_user" ? "withdrawn" : options.outcome
      : null;
    const withdrawnFilter = options.outcome === "withdrawn" || options.outcome === "withdrawn_by_user";
    const interactionOutcome = options.outcome === "accepted" || options.outcome === "rejected"
      ? or(eq(issueThreadInteractions.status, options.outcome), and(completedItemReview,
        sql`${issueThreadInteractions.result} @> ${JSON.stringify({ items: [{ verdict: options.outcome === "accepted" ? "approve" : "reject" }] })}::jsonb`))
      : options.outcome === "answered"
        ? and(eq(issueThreadInteractions.status, "answered"), sql`${issueThreadInteractions.kind} <> 'request_item_verdicts'`)
        : resultOutcomeFilter
          ? and(sql`${issueThreadInteractions.result}->>'outcome' = ${resultOutcomeFilter}`,
            options.outcome === "withdrawn_by_user" ? isNotNull(issueThreadInteractions.resolvedByUserId) : undefined)
          // "Expired" is a time-out or supersede; a card that closed with its
          // task is stored as expired too but has its own filter (plan §3).
          : options.outcome === "expired"
            ? and(eq(issueThreadInteractions.status, "expired"),
              sql`coalesce(${issueThreadInteractions.result}->>'outcome', '') <> 'issue_closed'`)
            : options.outcome ? eq(issueThreadInteractions.status, options.outcome) : undefined;
    // A decision a person withdrew is a cancelled decision with its closer
    // recorded; skipped and task-closed outcomes do not exist for decisions.
    const decisionOutcome = withdrawnFilter
      ? and(eq(decisions.status, "cancelled"), isNotNull(decisions.decidedByUserId))
      : resultOutcomeFilter
        ? sql`false`
        : options.outcome ? eq(decisions.status, options.outcome) : undefined;
    // Approvals use their own statuses. Approved and rejected map to the
    // shared Approved and Changes requested filters; a cancel by a person is
    // a withdraw. Approvals never expire, answer, decide or close with a task.
    const approvalStatusByFilter: Record<string, string> = { accepted: "approved", rejected: "rejected" };
    const approvalOutcome = withdrawnFilter
      ? and(eq(approvals.status, "cancelled"), isNotNull(approvals.decidedByUserId))
      : resultOutcomeFilter || options.outcome === "answered" || options.outcome === "decided" || options.outcome === "expired"
        ? sql`false`
        : options.outcome ? eq(approvals.status, approvalStatusByFilter[options.outcome] ?? options.outcome) : undefined;
    // "Handled by me or for me" (PAP-768): what the person answered, withdrew
    // or transferred, what a different person handled for them, and the cards
    // whose audience is them: the addressee or requester, else the task's person.
    const mine = options.scope === "mine";
    const userId = options.userId;
    const interactionScope = mine ? or(
      eq(issueThreadInteractions.resolvedByUserId, userId),
      eq(issueThreadInteractions.addresseeUserId, userId),
      and(isNull(issueThreadInteractions.addresseeUserId), issueAudienceIsUserCondition(companyId, userId)),
      handledByOrForUserSourceCondition(companyId, userId, "issue_thread_interaction", issueThreadInteractions.id),
    ) : undefined;
    const decisionScope = mine ? or(
      eq(decisions.decidedByUserId, userId),
      issueAudienceIsUserCondition(companyId, userId),
      handledByOrForUserSourceCondition(companyId, userId, "decision", decisions.id),
    ) : undefined;
    const approvalScope = mine ? or(
      eq(approvals.decidedByUserId, userId),
      eq(approvals.requestedByUserId, userId),
      and(isNull(approvals.requestedByUserId), isNotNull(issues.id), issueAudienceIsUserCondition(companyId, userId)),
      // A hard stop's override approval is folded into the budget owner's card.
      and(eq(approvals.type, "budget_override_required"),
        sql`exists (select 1 from ${companies} where ${companies.id} = ${companyId} and ${companies.budgetOwnerUserId} = ${userId})`),
      handledByOrForUserSourceCondition(companyId, userId, "approval", approvals.id),
    ) : undefined;
    const conditions = (time: SQL, key: SQL, title: SQL | typeof decisions.title | typeof issueThreadInteractions.title) => [
      options.issueIds ? inArray(issues.id, options.issueIds) : undefined,
      options.projectId ? eq(issues.projectId, options.projectId) : undefined,
      options.search ? or(ilike(title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`), ilike(issues.identifier, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`), ilike(issues.title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`)) : undefined,
      since ? sql`${time} >= ${since.toISOString()}::timestamptz` : undefined,
      cursor ? sql`(${time}, ${key}) ${sql.raw(sort === "oldest" ? ">" : "<")} (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
    ];
    const order = sort === "oldest" ? asc : desc;
    // Three bounded queries, keyset-paginated before materializing payloads.
    // Every task and every Decisions-v1 target passes the same task-read
    // predicate; an approval linked to a task needs that task to be readable.
    const [interactionRows, decisionRows, approvalRows] = await Promise.all([
      db.select({ sourceId: issueThreadInteractions.id, issueId: issues.id, issueIdentifier: issues.identifier, issueTitle: issues.title,
        agentId: agents.id, agentName: agents.name, projectId: projects.id, projectName: projects.name,
        title: issueThreadInteractions.title, outcome: issueThreadInteractions.status, resolvedAt: issueThreadInteractions.resolvedAt,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId, resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        kind: issueThreadInteractions.kind, payload: issueThreadInteractions.payload, result: issueThreadInteractions.result })
        .from(issueThreadInteractions).innerJoin(issues, and(eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, companyId)))
        .leftJoin(agents, and(eq(agents.id, issueThreadInteractions.createdByAgentId), eq(agents.companyId, companyId)))
        .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, companyId)))
        .where(and(eq(issueThreadInteractions.companyId, companyId), readable, isNotNull(issueThreadInteractions.resolvedAt),
          notInArray(issueThreadInteractions.status, ["pending"]),
          interactionOutcome, interactionScope,
          options.handledForMe ? handledForUserSourceCondition(companyId, options.userId, "issue_thread_interaction", issueThreadInteractions.id) : undefined,
          options.agentId ? eq(issueThreadInteractions.createdByAgentId, options.agentId) : undefined,
          ...conditions(interactionTime, interactionKey, issueThreadInteractions.title)))
        .orderBy(order(interactionTime), order(interactionKey)).limit(limit + 1),
      db.select({ sourceId: decisions.id, issueId: issues.id, issueIdentifier: issues.identifier, issueTitle: issues.title,
        agentId: agents.id, agentName: agents.name, projectId: projects.id, projectName: projects.name,
        title: decisions.title, outcome: decisions.status, resolvedAt: decisionTime,
        resolvedByUserId: decisions.decidedByUserId, chosenOptionId: decisions.chosenOptionId, options: decisions.options,
        metadata: decisions.metadata })
        .from(decisions).innerJoin(issues, and(eq(issues.id, decisions.originIssueId), eq(issues.companyId, companyId)))
        .leftJoin(agents, and(eq(agents.id, decisions.originAgentId), eq(agents.companyId, companyId)))
        .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, companyId)))
        .where(and(eq(decisions.companyId, companyId), readable, notInArray(decisions.status, ["open"]),
          sql`not exists (select 1 from ${decisionTargetIssues} where ${decisionTargetIssues.decisionId} = ${decisions.id} and (${decisionTargetIssues.companyId} <> ${companyId} or ${decisionTargetIssues.issueId} not in (${readableIssues})))`,
          decisionOutcome, decisionScope,
          options.handledForMe ? handledForUserSourceCondition(companyId, options.userId, "decision", decisions.id) : undefined,
          options.agentId ? eq(decisions.originAgentId, options.agentId) : undefined,
          ...conditions(decisionTime, decisionKey, decisions.title)))
        .orderBy(order(decisionTime), order(decisionKey)).limit(limit + 1),
      db.select({ sourceId: approvals.id, issueId: issues.id, issueIdentifier: issues.identifier, issueTitle: issues.title,
        agentId: agents.id, agentName: agents.name, projectId: projects.id, projectName: projects.name,
        type: approvals.type, payload: approvals.payload, outcome: approvals.status, resolvedAt: approvalTime,
        resolvedByUserId: approvals.decidedByUserId, decisionNote: approvals.decisionNote })
        .from(approvals).leftJoin(issues, and(eq(issues.id, approvalIssueId), eq(issues.companyId, companyId)))
        .leftJoin(agents, and(eq(agents.id, approvals.requestedByAgentId), eq(agents.companyId, companyId)))
        .leftJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, companyId)))
        .where(and(eq(approvals.companyId, companyId), await approvalReadSqlCondition(db, options.actor), notInArray(approvals.status, ["pending"]),
          or(sql`${approvalIssueId} is null`, and(isNotNull(issues.id), readable)),
          approvalOutcome, approvalScope,
          options.handledForMe ? handledForUserSourceCondition(companyId, options.userId, "approval", approvals.id) : undefined,
          options.agentId ? eq(approvals.requestedByAgentId, options.agentId) : undefined,
          ...conditions(approvalTime, approvalKey, approvalTitleSql)))
        .orderBy(order(approvalTime), order(approvalKey)).limit(limit + 1),
    ]);
    const interactionItems: DecisionHistoryItem[] = interactionRows.map(({ kind, payload, result, ...row }) => {
      const target = decisionHistoryTarget(payload);
      return { ...row, title: row.title ?? row.issueTitle, resolvedAt: new Date(row.resolvedAt!).toISOString(),
        id: `issue_thread_interaction:${row.sourceId}`, sourceKind: "issue_thread_interaction",
        label: interactionHistoryLabel({ kind, status: row.outcome, result, resolvedByUserId: row.resolvedByUserId }),
        action: interactionHistoryAction({ kind, status: row.outcome, result, resolvedByUserId: row.resolvedByUserId }),
        resultOutcome: interactionHistoryResultOutcome(result),
        reason: interactionHistoryReason(result), target,
        href: decisionHistoryHref(company.prefix, row.issueIdentifier ?? row.issueId, "issue_thread_interaction", row.sourceId, target) };
    });
    const decisionItems: DecisionHistoryItem[] = decisionRows.map(({ chosenOptionId, options: choices, metadata, ...row }) => {
      const chosenLabel = choices.find((choice) => choice.id === chosenOptionId)?.label ?? null;
      return {
      ...row, id: `decision:${row.sourceId}`, sourceKind: "decision", resolvedByAgentId: null,
      resolvedAt: new Date(row.resolvedAt).toISOString(), target: null,
      label: chosenLabel ?? (row.outcome === "expired" ? "Expired"
        : row.outcome === "cancelled" ? HISTORY_OUTCOME_LABELS[row.resolvedByUserId ? "withdrawn_by_user" : "cancelled"] : "Decision recorded"),
      action: decisionHistoryAction({ status: row.outcome, resolvedByUserId: row.resolvedByUserId, chosenLabel }),
      resultOutcome: row.outcome === "cancelled" && row.resolvedByUserId ? "withdrawn" : null,
      reason: interactionHistoryReason({ reason: metadata.cancelReason }),
      href: decisionHistoryHref(company.prefix, row.issueIdentifier ?? row.issueId, "decision", row.sourceId, null),
      };
    });
    const approvalItems: DecisionHistoryItem[] = approvalRows.map(({ type, payload, decisionNote, ...row }) => {
      const withdrawn = row.outcome === "cancelled" && row.resolvedByUserId != null;
      return {
        ...row, id: `approval:${row.sourceId}`, sourceKind: "approval", resolvedByAgentId: null,
        title: approvalTitle(type, payload), resolvedAt: new Date(row.resolvedAt).toISOString(), target: null,
        label: approvalHistoryLabel({ status: row.outcome, decidedByUserId: row.resolvedByUserId, type }),
        action: approvalHistoryAction({ status: row.outcome, decidedByUserId: row.resolvedByUserId, type }),
        resultOutcome: withdrawn ? "withdrawn" : null,
        // The decision note is the withdraw reason only for a cancel.
        reason: row.outcome === "cancelled" ? interactionHistoryReason({ reason: decisionNote }) : null,
        // An approval's own page lists its linked tasks and the full decision.
        href: `/${encodeURIComponent(company.prefix)}/approvals/${encodeURIComponent(row.sourceId)}`,
      };
    });
    const page = pageDecisionHistory([...interactionItems, ...decisionItems, ...approvalItems], limit, sort);
    const handledFor = await handledForBySource(db, companyId, page.items);
    for (const item of page.items) item.handledForUserId = handledFor.get(item.id) ?? null;
    return page;
  } };
}
