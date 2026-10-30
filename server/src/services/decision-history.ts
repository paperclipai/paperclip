import { and, asc, desc, eq, ilike, inArray, isNotNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { agents, companies, decisions, decisionTargetIssues, issues, issueThreadInteractions, projects, type Db } from "@paperclipai/db";
import type { DecisionHistoryItem, DecisionHistoryPage, DecisionHistoryQuery } from "@paperclipai/shared";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { badRequest } from "../errors.js";

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

/** History outcome filters that read `result.outcome`, not the status. */
const RESULT_OUTCOME_FILTERS = new Set(["withdrawn", "withdrawn_by_user", "skipped", "issue_closed"]);

function readRecordValue(value: unknown, key: string) {
  return value && typeof value === "object" && !Array.isArray(value) && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
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
    if (parsed.sort !== sort || typeof parsed.id !== "string" || !/^(decision|issue_thread_interaction):[0-9a-f-]{36}$/i.test(parsed.id)
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
    const interactionKey = sql<string>`'issue_thread_interaction:' || ${issueThreadInteractions.id}`;
    const decisionKey = sql<string>`'decision:' || ${decisions.id}`;
    const completedItemReview = and(eq(issueThreadInteractions.kind, "request_item_verdicts"),
      eq(issueThreadInteractions.status, "answered"), sql`${issueThreadInteractions.result}->>'outcome' = 'resolved'`);
    // Item reviews retain their canonical answered status, but outcome filters
    // describe the recorded verdicts. A mixed review can match both outcomes.
    const resultOutcomeFilter = options.outcome && RESULT_OUTCOME_FILTERS.has(options.outcome)
      ? options.outcome === "withdrawn_by_user" ? "withdrawn" : options.outcome
      : null;
    const interactionOutcome = options.outcome === "accepted" || options.outcome === "rejected"
      ? or(eq(issueThreadInteractions.status, options.outcome), and(completedItemReview,
        sql`${issueThreadInteractions.result} @> ${JSON.stringify({ items: [{ verdict: options.outcome === "accepted" ? "approve" : "reject" }] })}::jsonb`))
      : options.outcome === "answered"
        ? and(eq(issueThreadInteractions.status, "answered"), sql`${issueThreadInteractions.kind} <> 'request_item_verdicts'`)
        : resultOutcomeFilter
          ? and(sql`${issueThreadInteractions.result}->>'outcome' = ${resultOutcomeFilter}`,
            options.outcome === "withdrawn_by_user" ? isNotNull(issueThreadInteractions.resolvedByUserId) : undefined)
          : options.outcome ? eq(issueThreadInteractions.status, options.outcome) : undefined;
    // A decision a person withdrew is a cancelled decision with its closer
    // recorded; skipped and task-closed outcomes do not exist for decisions.
    const decisionOutcome = options.outcome === "withdrawn" || options.outcome === "withdrawn_by_user"
      ? and(eq(decisions.status, "cancelled"), isNotNull(decisions.decidedByUserId))
      : resultOutcomeFilter
        ? sql`false`
        : options.outcome ? eq(decisions.status, options.outcome) : undefined;
    const conditions = (time: SQL, key: SQL, title: SQL | typeof decisions.title | typeof issueThreadInteractions.title) => [
      options.issueIds ? inArray(issues.id, options.issueIds) : undefined,
      options.projectId ? eq(issues.projectId, options.projectId) : undefined,
      options.search ? or(ilike(title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`), ilike(issues.identifier, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`), ilike(issues.title, `%${options.search.replace(/[\\%_]/g, "\\$&")}%`)) : undefined,
      since ? sql`${time} >= ${since.toISOString()}::timestamptz` : undefined,
      cursor ? sql`(${time}, ${key}) ${sql.raw(sort === "oldest" ? ">" : "<")} (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
    ];
    const order = sort === "oldest" ? asc : desc;
    // Two bounded queries, keyset-paginated before materializing payloads. Every
    // task and every Decisions-v1 target passes the same task-read predicate.
    const [interactionRows, decisionRows] = await Promise.all([
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
          interactionOutcome,
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
          decisionOutcome,
          options.agentId ? eq(decisions.originAgentId, options.agentId) : undefined,
          ...conditions(decisionTime, decisionKey, decisions.title)))
        .orderBy(order(decisionTime), order(decisionKey)).limit(limit + 1),
    ]);
    const interactionItems: DecisionHistoryItem[] = interactionRows.map(({ kind, payload, result, ...row }) => {
      const target = decisionHistoryTarget(payload);
      return { ...row, title: row.title ?? row.issueTitle, resolvedAt: new Date(row.resolvedAt!).toISOString(),
        id: `issue_thread_interaction:${row.sourceId}`, sourceKind: "issue_thread_interaction",
        label: interactionHistoryLabel({ kind, status: row.outcome, result, resolvedByUserId: row.resolvedByUserId }),
        reason: interactionHistoryReason(result), target,
        href: decisionHistoryHref(company.prefix, row.issueIdentifier ?? row.issueId, "issue_thread_interaction", row.sourceId, target) };
    });
    const decisionItems: DecisionHistoryItem[] = decisionRows.map(({ chosenOptionId, options: choices, metadata, ...row }) => ({
      ...row, id: `decision:${row.sourceId}`, sourceKind: "decision", resolvedByAgentId: null,
      resolvedAt: new Date(row.resolvedAt).toISOString(), target: null,
      label: choices.find((choice) => choice.id === chosenOptionId)?.label ?? (row.outcome === "expired" ? "Expired"
        : row.outcome === "cancelled" ? HISTORY_OUTCOME_LABELS[row.resolvedByUserId ? "withdrawn_by_user" : "cancelled"] : "Decision recorded"),
      reason: interactionHistoryReason({ reason: metadata.cancelReason }),
      href: decisionHistoryHref(company.prefix, row.issueIdentifier ?? row.issueId, "decision", row.sourceId, null),
    }));
    return pageDecisionHistory([...interactionItems, ...decisionItems], limit, sort);
  } };
}
