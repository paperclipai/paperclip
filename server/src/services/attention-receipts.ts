import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  companies,
  decisions,
  inboxDismissals,
  issues,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import {
  ATTENTION_RECEIPT_DAYS,
  ATTENTION_RECEIPT_OUTCOMES,
  ATTENTION_SOURCE_KINDS,
  type AttentionAudience,
  type AttentionHandledDetails,
  type AttentionReceipt,
  type AttentionReceiptOutcome,
  type AttentionSourceKind,
  type BudgetScopeType,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { firstApprovalIssueId } from "./approval-visibility.js";
import {
  approvalTitle,
  escalateStaleAudience,
  interactionLabel,
  loadCompanyAttentionConfig,
  resolveAttentionAudience,
  resolveIssueAudienceContextMap,
  type AttentionAudienceInput,
} from "./attention.js";
import { approvalReadSqlCondition, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { budgetScopeName } from "./budgets.js";
import { deferrableInteractionCondition } from "./issue-question-context.js";

/**
 * Receipts for the other person (PAP-749 plan §6, Rule 12). When a person
 * answers, withdraws or transfers a card that was for a different person, the
 * action's activity entry names that person in `details.handledForUserId` and
 * describes the card in `details.receipt`. The For you feed reads those
 * entries back as receipts; there is no receipts table.
 */

const DAY_MS = 86_400_000;
const RECEIPT_LIMIT = 20;
/** Raw entries read per feed; several entries for one card collapse to one receipt. */
const RECEIPT_SCAN_LIMIT = 200;
export const ATTENTION_RECEIPT_DISMISSAL_PREFIX = "attention:receipt:";

/**
 * Sources a person can answer, withdraw or transfer for somebody else. A
 * budget card is for a person only when it is a hard stop with a budget owner
 * (task 1d).
 */
export type AttentionHandledSourceKind = Extract<
  AttentionSourceKind,
  "issue_thread_interaction" | "approval" | "decision" | "budget_alert"
>;

/** The card a person is about to act on, and who it is for right now. */
export type AttentionHandledFor = {
  userId: string;
  actorUserId: string;
  sourceKind: AttentionHandledSourceKind;
  sourceId: string;
  issueId: string | null;
  title: string | null;
};

/** The activity `details` fragment of a receipt; empty when there is no other person. */
export type AttentionHandledDetailsFragment =
  | { handledForUserId: string; receipt: AttentionHandledDetails }
  | Record<string, never>;

/**
 * Where one card shows right now, by the same rules as the feed (Rule 2 and
 * the Rule 10 escalation), without building the whole feed. `null` when the
 * source does not exist or is not a card for a person (an invokable agent's
 * request stays with the agent).
 */
export async function resolveAttentionCardAudience(
  db: Db,
  companyId: string,
  source: { sourceKind: AttentionHandledSourceKind; sourceId: string },
  now = Date.now(),
): Promise<{ audience: AttentionAudience; issueId: string | null; title: string | null } | null> {
  let input: AttentionAudienceInput;
  let title: string | null;
  let since: Date;
  let required: boolean;
  if (source.sourceKind === "issue_thread_interaction") {
    const [row] = await db
      .select({
        issueId: issueThreadInteractions.issueId,
        kind: issueThreadInteractions.kind,
        title: issueThreadInteractions.title,
        summary: issueThreadInteractions.summary,
        addresseeUserId: issueThreadInteractions.addresseeUserId,
        addresseeAgentId: issueThreadInteractions.addresseeAgentId,
        createdAt: issueThreadInteractions.createdAt,
        required: sql<boolean>`not ${deferrableInteractionCondition()}`,
      })
      .from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, source.sourceId)))
      .limit(1);
    if (!row) return null;
    if (row.addresseeAgentId && !row.addresseeUserId) {
      // A request to an agent that can still run is not a card for anyone.
      const companyAgentRows: AgentOrgRow[] = await db
        .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const addressee = companyAgentRows.find((agent) => agent.id === row.addresseeAgentId);
      if (evaluateAgentInvokability(addressee, companyAgentRows).invokable) return null;
    }
    input = { issueId: row.issueId, addresseeUserId: row.addresseeUserId };
    title = row.title ?? row.summary ?? interactionLabel(row.kind);
    since = row.createdAt;
    required = row.required === true;
  } else if (source.sourceKind === "approval") {
    const [row] = await db
      .select({
        type: approvals.type,
        payload: approvals.payload,
        requestedByUserId: approvals.requestedByUserId,
        issueId: firstApprovalIssueId(),
        updatedAt: approvals.updatedAt,
      })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.id, source.sourceId)))
      .limit(1);
    if (!row) return null;
    input = { issueId: row.issueId ?? null, requestedByUserId: row.requestedByUserId };
    title = approvalTitle(row.type, row.payload);
    since = row.updatedAt;
    required = true;
  } else if (source.sourceKind === "budget_alert") {
    // The budget owner's card is the open hard stop (PAP-749 task 1d). It has
    // no issue; everything else about a budget card is a Company alert.
    const [row] = await db
      .select({
        scopeType: budgetIncidents.scopeType,
        scopeId: budgetIncidents.scopeId,
        thresholdType: budgetIncidents.thresholdType,
        status: budgetIncidents.status,
        createdAt: budgetIncidents.createdAt,
      })
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.id, source.sourceId)))
      .limit(1);
    if (!row || row.status !== "open") return null;
    const hard = row.thresholdType === "hard";
    input = { issueId: null, companyScoped: true, escalatesToBudgetOwner: hard };
    const scopeName = await budgetScopeName(db, row.scopeType as BudgetScopeType, row.scopeId);
    title = `${scopeName} budget ${hard ? "hard stop" : "warning"}`;
    since = row.createdAt;
    required = false;
  } else {
    const [row] = await db
      .select({ originIssueId: decisions.originIssueId, title: decisions.title, createdAt: decisions.createdAt })
      .from(decisions)
      .where(and(eq(decisions.companyId, companyId), eq(decisions.id, source.sourceId)))
      .limit(1);
    if (!row) return null;
    input = { issueId: row.originIssueId };
    title = row.title;
    since = row.createdAt;
    required = false;
  }
  const [contexts, config] = await Promise.all([
    resolveIssueAudienceContextMap(db, companyId, [input.issueId]),
    loadCompanyAttentionConfig(db, companyId),
  ]);
  const companyConfig = {
    defaultDecisionOwnerUserId: config.defaultDecisionOwnerUserId,
    budgetOwnerUserId: config.budgetOwnerUserId,
  };
  const ctx = input.issueId ? contexts.get(input.issueId) ?? null : null;
  const audience = escalateStaleAudience({
    audience: resolveAttentionAudience(input, ctx, companyConfig),
    since,
    required,
    now,
    companyConfig,
    ctx,
  });
  return { audience, issueId: input.issueId, title };
}

/**
 * Who a card is for when a person acts on it, read before the action changes
 * it. `null` when the actor is no person, the card is for nobody in
 * particular, or the actor is that person (no receipt for yourself). Never
 * throws: a missing receipt must not block the answer.
 */
export async function attentionHandledFor(
  db: Db,
  companyId: string,
  source: { sourceKind: AttentionHandledSourceKind; sourceId: string },
  actorUserId: string | null | undefined,
): Promise<AttentionHandledFor | null> {
  if (!actorUserId) return null;
  try {
    const card = await resolveAttentionCardAudience(db, companyId, source);
    if (!card || card.audience.kind !== "user" || !card.audience.userId) return null;
    if (card.audience.userId === actorUserId) return null;
    return {
      userId: card.audience.userId,
      actorUserId,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      issueId: card.issueId,
      title: card.title,
    };
  } catch (err) {
    logger.warn({ err, companyId, ...source }, "attention receipt audience lookup failed");
    return null;
  }
}

/** Spread into the action's activity `details`. Empty when there is no other person. */
export function attentionHandledDetails(
  handledFor: AttentionHandledFor | null | undefined,
  outcome: AttentionReceiptOutcome,
  extra: { reason?: string | null; transferredToUserId?: string | null } = {},
): AttentionHandledDetailsFragment {
  if (!handledFor) return {};
  return {
    handledForUserId: handledFor.userId,
    receipt: {
      outcome,
      sourceKind: handledFor.sourceKind,
      sourceId: handledFor.sourceId,
      issueId: handledFor.issueId,
      title: handledFor.title,
      actorUserId: handledFor.actorUserId,
      ...(extra.reason?.trim() ? { reason: extra.reason.trim() } : {}),
      ...(extra.transferredToUserId ? { transferredToUserId: extra.transferredToUserId } : {}),
    },
  };
}

export function attentionReceiptDismissalKey(activityId: string) {
  return `${ATTENTION_RECEIPT_DISMISSAL_PREFIX}${activityId}`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** The stored receipt of one activity entry, or `null` when it is malformed. */
export function readAttentionHandledDetails(details: unknown): AttentionHandledDetails | null {
  if (!details || typeof details !== "object") return null;
  const receipt = (details as Record<string, unknown>).receipt;
  if (!receipt || typeof receipt !== "object") return null;
  const record = receipt as Record<string, unknown>;
  const outcome = readString(record.outcome);
  const sourceKind = readString(record.sourceKind);
  const sourceId = readString(record.sourceId);
  const actorUserId = readString(record.actorUserId);
  if (!outcome || !(ATTENTION_RECEIPT_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (!sourceKind || !(ATTENTION_SOURCE_KINDS as readonly string[]).includes(sourceKind)) return null;
  if (!sourceId || !actorUserId) return null;
  return {
    outcome: outcome as AttentionReceiptOutcome,
    sourceKind: sourceKind as AttentionSourceKind,
    sourceId,
    issueId: readString(record.issueId),
    title: readString(record.title),
    actorUserId,
    reason: readString(record.reason),
    transferredToUserId: readString(record.transferredToUserId),
  };
}

/** SQL: the entry names this person as the one a card was for. */
export function handledForUserCondition(userId: string) {
  return sql<boolean>`(${activityLog.details} ->> 'handledForUserId') = ${userId}`;
}

export function attentionReceiptService(db: Db) {
  return {
    /**
     * Receipts for one person, newest first: one per card, from the last
     * {@link ATTENTION_RECEIPT_DAYS} days, without the ones they dismissed or
     * can no longer read.
     */
    list: async (
      companyId: string,
      options: { userId: string; actor: AuthorizationActor; now?: number },
    ): Promise<AttentionReceipt[]> => {
      const now = options.now ?? Date.now();
      const since = new Date(now - ATTENTION_RECEIPT_DAYS * DAY_MS);
      const rows = await db
        .select({ id: activityLog.id, createdAt: activityLog.createdAt, details: activityLog.details })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, companyId),
          handledForUserCondition(options.userId),
          gte(activityLog.createdAt, since),
        ))
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(RECEIPT_SCAN_LIMIT);

      // Withdraw through Needs You writes the source's own entry and
      // `attention.closed`; both name the person. Keep the newest per card.
      const seen = new Set<string>();
      const candidates: Array<{ id: string; createdAt: Date; receipt: AttentionHandledDetails }> = [];
      for (const row of rows) {
        const receipt = readAttentionHandledDetails(row.details);
        if (!receipt || receipt.actorUserId === options.userId) continue;
        const key = `${receipt.sourceKind}:${receipt.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ id: row.id, createdAt: row.createdAt, receipt });
      }
      if (candidates.length === 0) return [];

      const keys = candidates.map((candidate) => attentionReceiptDismissalKey(candidate.id));
      const issueIds = [...new Set(candidates.map((candidate) => candidate.receipt.issueId).filter((id): id is string => Boolean(id)))];
      const readCondition = await issueReadSqlCondition(db, options.actor);
      const approvalIds = candidates.filter(candidate => candidate.receipt.sourceKind === "approval").map(candidate => candidate.receipt.sourceId);
      const approvalRead = await approvalReadSqlCondition(db, options.actor);
      const [dismissedRows, issueRows, company, approvalRows] = await Promise.all([
        db
          .select({ itemKey: inboxDismissals.itemKey })
          .from(inboxDismissals)
          .where(and(
            eq(inboxDismissals.companyId, companyId),
            eq(inboxDismissals.userId, options.userId),
            inArray(inboxDismissals.itemKey, keys),
          )),
        issueIds.length > 0
          ? db
            .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds), readCondition))
          : Promise.resolve([]),
        db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId)).then((r) => r[0] ?? null),
        approvalIds.length ? db.select({ id: approvals.id }).from(approvals).where(and(
          eq(approvals.companyId, companyId), inArray(approvals.id, approvalIds), approvalRead,
        )) : Promise.resolve([]),
      ]);
      const dismissed = new Set(dismissedRows.map((row) => row.itemKey));
      const readableIssues = new Map(issueRows.map((row) => [row.id, row]));
      const readableApprovals = new Set(approvalRows.map(row => row.id));
      const prefix = company?.prefix ?? "PAP";

      const receipts: AttentionReceipt[] = [];
      for (const { id, createdAt, receipt } of candidates) {
        const dismissalKey = attentionReceiptDismissalKey(id);
        if (dismissed.has(dismissalKey)) continue;
        if (receipt.sourceKind === "approval" && !readableApprovals.has(receipt.sourceId)) continue;
        const issueRow = receipt.issueId ? readableIssues.get(receipt.issueId) : null;
        // A task the person can no longer read takes its receipt with it.
        if (receipt.issueId && !issueRow) continue;
        const issueHref = issueRow ? `/${prefix}/issues/${issueRow.identifier ?? issueRow.id}` : null;
        receipts.push({
          id,
          dismissalKey,
          outcome: receipt.outcome,
          sourceKind: receipt.sourceKind,
          sourceId: receipt.sourceId,
          title: receipt.title,
          reason: receipt.reason ?? null,
          actorUserId: receipt.actorUserId,
          transferredToUserId: receipt.transferredToUserId ?? null,
          issue: issueRow && issueHref
            ? { id: issueRow.id, identifier: issueRow.identifier, title: issueRow.title, href: issueHref }
            : null,
          href: receipt.sourceKind === "approval"
            ? `/${prefix}/approvals/${receipt.sourceId}`
            : receipt.sourceKind === "budget_alert"
              ? `/${prefix}/costs`
              : issueHref && receipt.sourceKind === "issue_thread_interaction"
                ? `${issueHref}#interaction-${receipt.sourceId}`
                : issueHref,
          createdAt: createdAt.toISOString(),
          expiresAt: new Date(createdAt.getTime() + ATTENTION_RECEIPT_DAYS * DAY_MS).toISOString(),
        });
        if (receipts.length >= RECEIPT_LIMIT) break;
      }
      return receipts;
    },
  };
}
