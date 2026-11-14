import { recoveryActionAttentionCondition, ATTENTION_BUDGET_WARNING_PERCENT, ATTENTION_AGENT_ERROR_STATUS, collapsePendingConfirmationsToNewest, loadNewestSettledConfirmationAt, readRunIssueId, listFailedRunsWithNewerRun, requiresReviewAttention, terminalBlockerRequiresAttention } from "./attention-source-eligibility.js";
import { approvalExecutionIssueCondition, firstApprovalIssueId } from "./approval-visibility.js";
import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionTrainingExamples,
  decisionTriage,
  decisions,
  heartbeatRuns,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  documents,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { ATTENTION_CLAIMABLE_SOURCE_KINDS, ATTENTION_PERSONAL_VIEWS, deriveProjectUrlKey } from "@paperclipai/shared";
import { normalizedContentHash } from "@paperclipai/shared/portability-hash";
import type {
  AttentionAudience,
  AttentionClaimResult,
  AttentionCloseMode,
  AttentionDecisionVerb,
  AttentionFeed,
  AttentionSummary,
  AttentionTaskIndex,
  AttentionFeedQuery,
  AttentionFeedView,
  AttentionDetailImage,
  AttentionItem,
  AttentionItemDetail,
  AttentionRequestKind,
  AttentionProjectRef,
  AttentionQueueRef,
  AttentionResolverAudience,
  AttentionSeverity,
  AttentionSortMode,
  AttentionSourceKind,
  AttentionStale,
  AttentionSubject,
  AttentionTransferResult,
  AttentionTriageAttribution,
  AttentionViewCounts,
  AttentionWorkspaceRef,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionResolverPolicyProvenance,
  IssueReviewPolicy,
} from "@paperclipai/shared";
import { withoutSqlStatementText } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { listAttentionExhaustedRuns } from "./attention-exhausted-runs.js";
import { budgetService } from "./budgets.js";
import {
  BLOCKER_ATTENTION_MAX_DEPTH,
  BLOCKER_ATTENTION_MAX_NODES,
  issueService,
} from "./issues.js";
import { attentionIssueCondition, executionIssueCondition } from "./issue-visibility.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isProspectiveBlockedTransition } from "./routable-blocked.js";
import { authorizationService, canActorReadApproval, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { humanCreatedIssueCondition } from "./issue-participation.js";
import { attentionAlreadyClosedError } from "./attention-already-closed.js";
import { inboxDismissalService } from "./inbox-dismissals.js";
import { assertInteractionRoutingRecipientAllowed } from "./issue-thread-interactions.js";
import { resolvableApprovalStatuses } from "../lib/approval-records.js";
import { activeIssueInteractionCondition, deferrableInteractionCondition } from "./issue-question-context.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { canonicalizeStoredResolverPolicy } from "./issue-thread-interaction-resolution.js";
import { decisionQueueService } from "./decision-queues.js";
import {
  decisionRetentionService,
  DEFAULT_DECISION_SHELF_DAYS,
} from "./decision-retention.js";

const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  "productivity_review",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  failed_run: 0,
  recovery_action: 1,
  blocker_attention: 2,
  budget_alert: 3,
  agent_error_alert: 4,
  approval: 5,
  decision: 6,
  issue_thread_interaction: 7,
  review: 8,
  productivity_review: 9,
  join_request: 10,
};

const PENDING_INTERACTION_STATUSES = ["pending"] as const;
const DETAIL_EXCERPT_LENGTH = 160;
const DETAIL_IMAGE_LIMIT = 3;
const OPEN_DECISION_DEFAULT_LIMIT = 500;
const OPEN_DECISION_MAX_LIMIT = 1_000;
const ATTENTION_PAGE_DEFAULT_LIMIT = 50;
const ATTENTION_PAGE_MAX_LIMIT = 100;
const ATTENTION_GRAPH_QUERY_CHUNK_SIZE = 500;

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

type IssueSummaryRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  /** Who may give the `in_review` verdict; `null`/absent ≡ "anyone" (PAP-16506). */
  reviewPolicy?: IssueReviewPolicy | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
};

type IssueSubjectRow = Omit<IssueSummaryRow, "project" | "workspace">;

type DismissalState = {
  kind: "dismiss" | "snooze";
  dismissedAt: Date;
  snoozedUntil: Date | null;
  fingerprint: string | null;
};

type PlanDocumentSummary = {
  title: string | null;
  body: string;
};

type BlockingIssueSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
};

type AttentionListOptions = AttentionFeedQuery & {
  userId?: string | null;
  includeDismissed?: boolean;
  actor?: AuthorizationActor;
  /** Internal-only escape hatch for callers that need one stable, unpaginated feed snapshot. */
  allowUnscopedAll?: boolean;
  excludeSources?: readonly AttentionSourceKind[];
  /** Count the canonical complete set without card bodies or presentation reads. */
  summaryOnly?: boolean;
  /**
   * `summaryOnly` for a caller that reads the counts and not the items: it
   * also skips the reads that only say which task a card belongs to.
   */
  countsOnly?: boolean;
};

type AttentionServiceOptions = {
  openDecisionLimit?: number;
  now?: () => number;
};

function emptyCounts(): Record<AttentionSourceKind, number> {
  return Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AttentionSourceKind, number>;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function activeDismissalState(
  dismissalByKey: ReadonlyMap<string, DismissalState>,
  item: Pick<AttentionItem, "dismissalKey" | "activityAt" | "changeFingerprint">,
  now: number,
) {
  const dismissal = dismissalByKey.get(item.dismissalKey);
  if (!dismissal) return null;

  const dismissedAt = toIso(dismissal.dismissedAt);
  const snoozedUntil = dismissal.snoozedUntil ? toIso(dismissal.snoozedUntil) : null;
  // PAP-749 Rule 9: a hidden card returns only on an important change. Rows
  // saved before the fingerprint existed keep the old activity-time rule.
  const covered = dismissalCoversChange(dismissal.fingerprint, item.changeFingerprint);
  const isActive = dismissal.kind === "snooze"
    ? dismissal.snoozedUntil != null && timestamp(dismissal.snoozedUntil) > now && covered !== false
    : covered ?? timestamp(dismissal.dismissedAt) >= timestamp(item.activityAt);

  return {
    kind: dismissal.kind,
    dismissedAt,
    snoozedUntil,
    isActive,
  };
}

/**
 * Plain text for a card excerpt. Removes markdown syntax only, so characters
 * inside words and numbers stay: "(#2)", "in-review", "snake_case", an email
 * address (PAP-767).
 */
export function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    // Block syntax at the start of a line: rules, quotes and list bullets.
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, " ")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    // Emphasis and strikethrough markers around text.
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(value: unknown, maxLength = DETAIL_EXCERPT_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = stripMarkdown(value);
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlanDocumentTarget(payload: Record<string, unknown>) {
  const target = readRecord(payload.target);
  return target.type === "issue_document" && target.key === "plan";
}

function issueContext(issue: IssueSummaryRow | IssueSubjectRow | null | undefined) {
  const summary = issue && "project" in issue ? issue : null;
  return {
    project: summary?.project ?? null,
    workspace: summary?.workspace ?? null,
  };
}

function issueImages(imageMap: ReadonlyMap<string, AttentionDetailImage[]>, issueId: string | null | undefined) {
  return issueId ? imageMap.get(issueId) ?? [] : [];
}

function genericDetail(summary: unknown, images: AttentionDetailImage[]): AttentionItemDetail {
  return { kind: "generic", summaryExcerpt: excerpt(summary), images };
}

function approvalDetail(type: string, payload: Record<string, unknown>): AttentionItemDetail {
  return {
    kind: "approval",
    approvalType: type,
    summaryExcerpt: excerpt(payload.summary ?? payload.title ?? payload.recommendedAction),
    images: [],
  };
}

function interactionDetail(input: {
  kind: string;
  payload: Record<string, unknown>;
  issue: IssueSummaryRow | null;
  planDocument: PlanDocumentSummary | null;
  images: AttentionDetailImage[];
}): AttentionItemDetail {
  if (input.kind === "request_confirmation" && isPlanDocumentTarget(input.payload)) {
    return {
      kind: "plan_approval",
      issueTitle: input.issue?.title ?? null,
      planTitle: input.planDocument?.title ?? "Plan",
      summaryExcerpt: excerpt(input.planDocument?.body ?? input.payload.detailsMarkdown ?? input.payload.prompt),
      images: input.images,
    };
  }

  if (input.kind === "ask_user_questions") {
    const questions = readArray(input.payload.questions).map(readRecord);
    return {
      kind: "questions",
      questionCount: questions.length,
      firstQuestionText: readString(questions[0]?.prompt),
      images: input.images,
    };
  }

  if (input.kind === "suggest_tasks") {
    const tasks = readArray(input.payload.tasks).map(readRecord);
    return {
      kind: "suggested_tasks",
      taskCount: tasks.length,
      firstTaskTitle: readString(tasks[0]?.title),
      images: input.images,
    };
  }

  if (input.kind === "request_checkbox_confirmation") {
    return {
      kind: "checkbox_confirmation",
      optionCount: readArray(input.payload.options).length,
      promptExcerpt: excerpt(input.payload.prompt),
      images: input.images,
    };
  }

  if (input.kind === "request_item_verdicts") {
    return {
      kind: "item_verdicts",
      itemCount: readArray(input.payload.items).length,
      promptExcerpt: excerpt(input.payload.prompt),
      images: input.images,
    };
  }

  return {
    kind: "confirmation",
    promptExcerpt: excerpt(input.payload.prompt ?? input.payload.detailsMarkdown),
    isPlanTarget: false,
    images: input.images,
  };
}

/**
 * What a confirmation is about (PAP-775), so the Needs You feed can pick the
 * card design before the interaction itself loads.
 */
function interactionRequestKind(kind: string, payload: Record<string, unknown>): AttentionRequestKind | null {
  const has = (key: string) => Object.keys(readRecord(payload[key])).length > 0;
  if (kind === "connection_intent") return has("accessRequest") ? "access" : "connection";
  if (kind !== "request_confirmation") return null;
  if (has("toolAction")) return "tool_action";
  if (has("secretProposal")) return "secret";
  if (has("connectionAuthorization")) return "connection";
  const target = readRecord(payload.target);
  if (target.type === "issue_attachment" || (target.type === "issue_document" && target.key !== "plan")) return "deliverable";
  return null;
}

function issueHref(prefix: string, issue: Pick<IssueSubjectRow, "id" | "identifier">) {
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function issueSubject(prefix: string, issue: IssueSubjectRow): AttentionSubject {
  return {
    kind: "issue",
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    href: issueHref(prefix, issue),
    metadata: {
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      // Only present when the row was selected with the column, so subjects
      // built from narrower selects do not claim a policy they never read.
      ...(issue.reviewPolicy !== undefined ? { reviewPolicy: issue.reviewPolicy } : {}),
    },
  };
}

function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

function decisionVerbs(...verbs: AttentionDecisionVerb[]): AttentionDecisionVerb[] {
  return verbs;
}

/**
 * Which Close… verbs a card supports (PAP-749 plan §2, Rule 6). Everyone can
 * archive or snooze a card for themselves. Withdraw needs a source with a real
 * withdraw or cancel: interactions, decisions and approvals. A hire approval is
 * rejected, not withdrawn, so its pending agent still gets a decision. Budget
 * cards use Raise limit and Keep paused; reviews, blockers, recovery and
 * operator alerts have no request to withdraw.
 */
export function attentionCloseModes(
  sourceKind: AttentionSourceKind,
  subject: Pick<AttentionSubject, "metadata">,
): AttentionCloseMode[] {
  if (sourceKind === "productivity_review") return [];
  const withdrawable = sourceKind === "issue_thread_interaction"
    || sourceKind === "decision"
    || (sourceKind === "approval" && subject.metadata?.type !== "hire_agent");
  return withdrawable ? ["withdraw", "archive", "snooze"] : ["archive", "snooze"];
}

type CreateAttentionItemInput = Omit<AttentionItem,
  | "id"
  | "dismissalKey"
  | "rank"
  | "dismissal"
  | "audience"
  | "stale"
  | "required"
  | "changeFingerprint"
  | "closeModes"
  | "obligationKey"
  | "obligationLeadId"
  | "project"
  | "workspace"
  | "expiresAt"
  | "ruleKey"
  | "originAgentName"
  | "requester"
  | "queues"
  | "shelf"
  | "retentionDays"
  | "keep"
  | "archivedAt"
  | "retentionVersion"
  | "decideBy"
  | "decideByAttribution"
  | "snoozedUntil"
  | "detail"
  | "trainingExampleId"
> & {
  project?: AttentionProjectRef | null;
  workspace?: AttentionWorkspaceRef | null;
  expiresAt?: string | null;
  ruleKey?: string | null;
  originAgentName?: string | null;
  detail?: AttentionItemDetail | null;
};

function createItem(input: CreateAttentionItemInput): AttentionItem {
  return {
    ...input,
    id: itemId(input.sourceKind, input.dedupKey),
    dismissalKey: `attention:${input.dedupKey}`,
    dismissal: null,
    // Placeholder; the audience post-pass overwrites this once per item once the
    // per-issue context is loaded (PAP-749 plan §1, Rule 2).
    audience: { kind: "pool", userId: null, reason: "none" },
    // Placeholders; the same post-pass sets these (PAP-749 plan §2, Rules 9-10).
    stale: null,
    required: false,
    changeFingerprint: "",
    closeModes: attentionCloseModes(input.sourceKind, input.subject),
    // Set by the obligation pass (PAP-749 plan §2, Rule 11).
    obligationKey: null,
    obligationLeadId: null,
    project: input.project ?? null,
    workspace: input.workspace ?? null,
    expiresAt: input.expiresAt ?? null,
    ruleKey: input.ruleKey ?? null,
    originAgentName: input.originAgentName ?? null,
    // Set by the enrichment pass, which loads agent names (PAP-775, UI2).
    requester: null,
    queues: [],
    shelf: false,
    retentionDays: DEFAULT_DECISION_SHELF_DAYS,
    keep: false,
    archivedAt: null,
    retentionVersion: 0,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: input.detail ?? null,
    trainingExampleId: null,
    resolverAudience: input.resolverAudience ?? null,
    rank: 0,
  };
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff = SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

function blockedTaskCount(item: AttentionItem) {
  return item.sourceKind === "blocker_attention"
    && item.detail?.kind === "blocker"
    && typeof item.detail.blockedTaskCount === "number"
    ? item.detail.blockedTaskCount
    : null;
}

/** Preserve the selected desk sort for every row slot while ordering blocker
 * rows by the amount of work they hold up. */
function orderBlockedAttentionByWeight(
  items: AttentionItem[],
  fallback: (left: AttentionItem, right: AttentionItem) => number,
) {
  const blockers = items
    .filter((item) => blockedTaskCount(item) !== null)
    .sort((left, right) => {
      const weightDiff = (blockedTaskCount(right) ?? 0) - (blockedTaskCount(left) ?? 0);
      return weightDiff !== 0 ? weightDiff : fallback(left, right);
    });
  if (blockers.length < 2) return items;

  let blockerIndex = 0;
  return items.map((item) => blockedTaskCount(item) === null ? item : blockers[blockerIndex++]!);
}

function sourceKey(sourceKind: AttentionSourceKind, sourceId: string) {
  return `${sourceKind}:${sourceId}`;
}

function itemSourceKey(item: AttentionItem) {
  return sourceKey(item.sourceKind, item.subject.id);
}

function readMetadataAgentId(item: AttentionItem) {
  const metadata = item.subject.metadata;
  const value = metadata?.originAgentId ?? metadata?.createdByAgentId ?? metadata?.requestedByAgentId
    ?? metadata?.agentId ?? (item.subject.kind === "agent" ? item.subject.id : null);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The person who asked, when a person (not an agent) created the request (PAP-775, UI2). */
function readMetadataRequesterUserId(item: AttentionItem) {
  const metadata = item.subject.metadata;
  const value = metadata?.requestedByUserId ?? metadata?.createdByUserId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function startOfUtcDay(now: number) {
  const value = new Date(now);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function endOfUtcDay(now: number) {
  return startOfUtcDay(now) + 24 * 60 * 60 * 1_000 - 1;
}

function endOfUtcWeek(now: number) {
  const start = startOfUtcDay(now);
  const weekday = new Date(start).getUTCDay();
  // Use an ISO-style Monday-Sunday week. Sunday (0) is already the last
  // day of the current week; every other day advances only to that Sunday.
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday;
  return start + (daysUntilSunday + 1) * 24 * 60 * 60 * 1_000 - 1;
}

function decideOrder(item: AttentionItem, now: number): [number, number] {
  if (item.decideBy === "today") return [0, endOfUtcDay(now)];
  if (item.decideBy === "this_week") return [0, endOfUtcWeek(now)];
  if (item.decideBy && /^\d{4}-\d{2}-\d{2}$/.test(item.decideBy)) {
    const deadline = Date.parse(`${item.decideBy}T23:59:59.999Z`);
    if (Number.isFinite(deadline)) return [0, deadline];
  }
  if (item.decideBy === "whenever") return [1, Number.MAX_SAFE_INTEGER];
  return [2, Number.MAX_SAFE_INTEGER];
}

function compareDecideItems(left: AttentionItem, right: AttentionItem, now: number) {
  const [leftBucket, leftDeadline] = decideOrder(left, now);
  const [rightBucket, rightDeadline] = decideOrder(right, now);
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

  const leftExpiry = left.expiresAt ? timestamp(left.expiresAt) : Number.MAX_SAFE_INTEGER;
  const rightExpiry = right.expiresAt ? timestamp(right.expiresAt) : Number.MAX_SAFE_INTEGER;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  return compareAttentionItems(left, right);
}

function encodeCursor(sort: AttentionSortMode, item: AttentionItem) {
  return Buffer.from(JSON.stringify({ v: 1, sort, id: item.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, sort: AttentionSortMode) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.v !== 1 || decoded.sort !== sort || typeof decoded.id !== "string" || !decoded.id) {
      throw new Error("invalid cursor shape");
    }
    return decoded.id;
  } catch {
    throw badRequest("Invalid attention cursor");
  }
}

function parseActivityBoundary(value: string | undefined, field: "activitySince" | "activityUntil") {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest(`${field} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} must be an ISO timestamp`);
  return parsed;
}

async function enrichAttentionItems(
  db: Db,
  companyId: string,
  items: AttentionItem[],
  now: number,
  includePresentation = true,
  includeQueues = true,
) {
  if (items.length === 0) return items;
  const sourceIds = [...new Set(items.map((item) => item.subject.id))];
  const queueRows = !includeQueues ? [] : await db
    .select({
      sourceKind: decisionQueueItems.sourceKind,
      sourceId: decisionQueueItems.sourceId,
      key: decisionQueues.key,
      title: decisionQueues.title,
      retentionDays: decisionQueues.retentionDays,
    })
    .from(decisionQueueItems)
    .innerJoin(decisionQueues, and(
      eq(decisionQueueItems.queueId, decisionQueues.id),
      eq(decisionQueues.companyId, companyId),
    ))
    .where(and(
      eq(decisionQueueItems.companyId, companyId),
      inArray(decisionQueueItems.sourceId, sourceIds),
    ))
    .orderBy(asc(decisionQueues.title), asc(decisionQueues.key));
  const queuesBySource = new Map<string, AttentionQueueRef[]>();
  const retentionDaysBySource = new Map<string, number[]>();
  for (const row of queueRows) {
    const key = sourceKey(row.sourceKind as AttentionSourceKind, row.sourceId);
    const queues = queuesBySource.get(key) ?? [];
    queues.push({ key: row.key, title: row.title });
    queuesBySource.set(key, queues);
    if (row.retentionDays != null) {
      const values = retentionDaysBySource.get(key) ?? [];
      values.push(row.retentionDays);
      retentionDaysBySource.set(key, values);
    }
  }

  const triageRows = await db
    .select()
    .from(decisionTriage)
    .where(and(
      eq(decisionTriage.companyId, companyId),
      inArray(decisionTriage.sourceId, sourceIds),
    ));
  const triageBySource = new Map(triageRows.map((row) => [
    sourceKey(row.sourceKind as AttentionSourceKind, row.sourceId),
    row,
  ]));

  const agentIds = [...new Set([
    ...items.map(readMetadataAgentId),
    ...triageRows.map((row) => row.setByAgentId),
  ].filter((value): value is string => Boolean(value)))];
  const agentNameById = new Map(!includePresentation || agentIds.length === 0 ? [] : await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
    .then((rows) => rows.map((row) => [row.id, row.name] as const)));

  const enriched = items.map((item) => {
    const triage = triageBySource.get(itemSourceKey(item));
    const decideBy = triage?.decideBy === "date" ? triage.decideByDate : triage?.decideBy ?? null;
    const decideByAttribution: AttentionTriageAttribution | null = triage ? {
      type: triage.setByType as AttentionTriageAttribution["type"],
      agentId: triage.setByAgentId ?? null,
      agentName: triage.setByAgentId ? agentNameById.get(triage.setByAgentId) ?? null : null,
      userId: triage.setByUserId ?? null,
      runId: triage.setByRunId ?? null,
      responsibleUserId: triage.responsibleUserId ?? null,
      updatedAt: toIso(triage.updatedAt),
    } : null;
    const originAgentId = readMetadataAgentId(item);
    const requesterUserId = readMetadataRequesterUserId(item);
    const originAgentName = originAgentId ? agentNameById.get(originAgentId) ?? null : null;
    return {
      ...item,
      originAgentName,
      requester: originAgentId && originAgentName
        ? { kind: "agent" as const, id: originAgentId, name: originAgentName }
        : requesterUserId ? { kind: "user" as const, id: requesterUserId, name: null } : null,
      queues: queuesBySource.get(itemSourceKey(item)) ?? [],
      decideBy,
      decideByAttribution,
      snoozedUntil: triage?.snoozedUntil ? toIso(triage.snoozedUntil) : null,
    };
  });
  const retentionBySource = await decisionRetentionService(db).syncItems(companyId, enriched);
  return enriched.map((item) => {
    const key = itemSourceKey(item);
    const retention = retentionBySource.get(key);
    const overrides = retentionDaysBySource.get(key) ?? [];
    const retentionDays = overrides.length > 0 ? Math.min(...overrides) : DEFAULT_DECISION_SHELF_DAYS;
    return {
      ...item,
      shelf: timestamp(item.activityAt) <= now - retentionDays * 86_400_000,
      retentionDays,
      keep: retention?.keep ?? false,
      archivedAt: retention?.archivedAt ? toIso(retention.archivedAt) : null,
      retentionVersion: retention?.version ?? 0,
    };
  });
}

function betterDuplicate(left: AttentionItem, right: AttentionItem) {
  return compareAttentionItems(left, right) <= 0 ? left : right;
}

export function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

export function interactionLabel(kind: string) {
  switch (kind) {
    case "request_confirmation":
      return "Confirmation requested";
    case "request_checkbox_confirmation":
      return "Selection confirmation requested";
    case "ask_user_questions":
      return "Questions need answers";
    case "suggest_tasks":
      return "Suggested tasks need a decision";
    case "request_item_verdicts":
      return "Item verdicts need a decision";
    default:
      return "Interaction needs a decision";
  }
}

function interactionVerbs(kind: string, payload: Record<string, unknown>) {
  if (kind === "ask_user_questions") {
    return decisionVerbs({
      id: "respond",
      label: "Respond",
      description: "Submit answers to the pending questions.",
    });
  }
  if (kind === "request_confirmation") {
    const acceptLabel = typeof payload.acceptLabel === "string" && payload.acceptLabel.trim()
      ? payload.acceptLabel.trim()
      : "Confirm";
    const rejectLabel = typeof payload.rejectLabel === "string" && payload.rejectLabel.trim()
      ? payload.rejectLabel.trim()
      : "Decline";
    return decisionVerbs(
      {
        id: "accept",
        label: acceptLabel,
        description: "Accept the pending confirmation.",
      },
      {
        id: "reject",
        label: rejectLabel,
        description: "Decline the pending confirmation.",
      },
    );
  }
  return decisionVerbs(
    {
      id: "accept",
      label: "Accept",
      description: "Accept the pending interaction.",
    },
    {
      id: "reject",
      label: "Reject",
      description: "Reject the pending interaction and provide a reason when required.",
    },
  );
}

/**
 * The resolver audience carried by an `issue_thread_interaction` feed row
 * (PAP-17287). A collapsed queue row offers Accept/Reject long before anything
 * fetches the interaction itself, so the audience the server will enforce has
 * to ride along with the item — the queue must never ask for a decision without
 * saying whose decision it is.
 *
 * Facts only. The stored columns are canonicalized through the same helper the
 * resolution evaluator uses, so a pre-migration row cannot read as `Anyone`
 * here while the API still treats it as `not_creator`.
 */
export function interactionResolverAudience(
  row: {
    addresseeAgentId: string | null;
    addresseeUserId?: string | null;
    createdByAgentId: string | null;
    requestedResolverPolicy: string;
    effectiveResolverPolicy: string;
    resolverPolicyProvenance: string | null;
    effectiveResolverPolicySource: string | null;
  },
  agentName: (agentId: string) => string | null,
): AttentionResolverAudience {
  const provenance = (row.resolverPolicyProvenance
    ?? (row.requestedResolverPolicy === "board_only" || row.requestedResolverPolicy === "board_or_agents"
      ? "legacy_inherited_restriction"
      : "inherited")) as IssueThreadInteractionResolverPolicyProvenance;
  return {
    requestedResolverPolicy: canonicalizeStoredResolverPolicy(row.requestedResolverPolicy, provenance),
    effectiveResolverPolicy: canonicalizeStoredResolverPolicy(row.effectiveResolverPolicy, provenance),
    effectiveResolverPolicySource:
      (row.effectiveResolverPolicySource ?? "requested") as IssueThreadInteractionEffectiveResolverPolicySource,
    resolverPolicyProvenance: provenance,
    addresseeAgentId: row.addresseeAgentId,
    addresseeUserId: row.addresseeUserId ?? null,
    addresseeName: row.addresseeAgentId ? agentName(row.addresseeAgentId) : null,
    createdByAgentId: row.createdByAgentId,
    createdByAgentName: row.createdByAgentId ? agentName(row.createdByAgentId) : null,
  };
}

function budgetObservedPercent(amountObserved: number, amountLimit: number) {
  return amountLimit > 0 ? Math.round((amountObserved / amountLimit) * 10_000) / 100 : 0;
}

/**
 * The configured escalation owners that are still active members of the
 * company. A removed or inactive owner sends cards on to the next step instead
 * of hiding them on a list nobody reads (PAP-749 plan §1, special conditions).
 */
async function activeMemberUserIds(db: Db, companyId: string, userIds: Array<string | null | undefined>) {
  const candidates = [...new Set(userIds.filter((value): value is string => Boolean(value)))];
  if (candidates.length === 0) return new Set<string>();
  const rows = await db
    .select({ principalId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      inArray(companyMemberships.principalId, candidates),
      eq(companyMemberships.status, "active"),
    ));
  return new Set(rows.map((row) => row.principalId));
}

/**
 * Company-level facts the feed needs once per request: the issue prefix for
 * href building and the company's escalation owners for the audience
 * post-pass: the default decision owner (task 1d-lite) and the budget owner
 * (task 1d).
 */
export async function loadCompanyAttentionConfig(db: Db, companyId: string) {
  const row = await db
    .select({
      issuePrefix: companies.issuePrefix,
      defaultDecisionOwnerUserId: companies.defaultDecisionOwnerUserId,
      budgetOwnerUserId: companies.budgetOwnerUserId,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const active = await activeMemberUserIds(db, companyId, [row?.defaultDecisionOwnerUserId, row?.budgetOwnerUserId]);
  const activeOrNull = (userId: string | null | undefined) => (userId && active.has(userId) ? userId : null);
  return {
    prefix: row?.issuePrefix ?? "PAP",
    defaultDecisionOwnerUserId: activeOrNull(row?.defaultDecisionOwnerUserId),
    budgetOwnerUserId: activeOrNull(row?.budgetOwnerUserId),
  };
}

async function dismissalByKey(db: Db, companyId: string, userId: string | null | undefined) {
  if (!userId) return new Map<string, DismissalState>();
  const rows = await db
    .select({
      itemKey: inboxDismissals.itemKey,
      kind: inboxDismissals.kind,
      dismissedAt: inboxDismissals.dismissedAt,
      snoozedUntil: inboxDismissals.snoozedUntil,
      fingerprint: inboxDismissals.fingerprint,
    })
    .from(inboxDismissals)
    .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)));
  return new Map(rows.map((row) => [row.itemKey, {
    kind: row.kind,
    dismissedAt: row.dismissedAt,
    snoozedUntil: row.snoozedUntil,
    fingerprint: row.fingerprint,
  }]));
}

async function issueSummaryMap(
  db: Db,
  companyId: string,
  issueIds: Array<string | null | undefined>,
  readCondition: SQL<boolean> = sql<boolean>`true`,
  includeConversations = false,
  /** False for a count: the same tasks, without their project and workspace. */
  includeContext = true,
) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, IssueSummaryRow>();
  const readable = and(
    eq(issues.companyId, companyId),
    inArray(issues.id, ids),
    attentionIssueCondition(includeConversations),
    readCondition,
  );
  if (!includeContext) {
    const subjectRows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        reviewPolicy: issues.reviewPolicy,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(readable);
    return new Map<string, IssueSummaryRow>(subjectRows.map((row) => [row.id, {
      ...row,
      reviewPolicy: row.reviewPolicy ?? null,
      project: null,
      workspace: null,
    }]));
  }
  const rows = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      reviewPolicy: issues.reviewPolicy,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      projectId: projects.id,
      projectName: projects.name,
      projectColor: projects.color,
      projectIcon: projects.icon,
      workspaceId: projectWorkspaces.id,
      workspaceName: projectWorkspaces.name,
    })
    .from(issues)
    .leftJoin(projects, and(eq(issues.projectId, projects.id), eq(projects.companyId, companyId)))
    .leftJoin(projectWorkspaces, and(
      eq(issues.projectWorkspaceId, projectWorkspaces.id),
      eq(projectWorkspaces.companyId, companyId),
    ))
    .where(readable);
  return new Map<string, IssueSummaryRow>(rows.map((row) => [row.id, {
    id: row.id,
    companyId: row.companyId,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    reviewPolicy: row.reviewPolicy ?? null,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    project: row.projectId && row.projectName ? {
      id: row.projectId,
      name: row.projectName,
      urlKey: deriveProjectUrlKey(row.projectName, row.projectId),
      color: row.projectColor,
      icon: row.projectIcon,
    } : null,
    workspace: row.workspaceId && row.workspaceName ? {
      id: row.workspaceId,
      name: row.workspaceName,
    } : null,
  }]));
}

async function issueImageMap(
  db: Db,
  companyId: string,
  issueIds: Array<string | null | undefined>,
  readCondition: SQL<boolean> = sql<boolean>`true`,
) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, AttentionDetailImage[]>();
  const rows = await db
    .select({
      issueId: issueAttachments.issueId,
      assetId: issueAttachments.assetId,
      originalFilename: assets.originalFilename,
    })
    .from(issueAttachments)
    .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
    .innerJoin(issues, and(eq(issueAttachments.issueId, issues.id), eq(issues.companyId, companyId)))
    .where(and(
      eq(issueAttachments.companyId, companyId),
      eq(assets.companyId, companyId),
      inArray(issueAttachments.issueId, ids),
      sql`${assets.contentType} like 'image/%'`,
      readCondition,
    ))
    .orderBy(asc(issueAttachments.issueId), asc(issueAttachments.createdAt), asc(issueAttachments.id));

  const map = new Map<string, AttentionDetailImage[]>();
  for (const row of rows) {
    const images = map.get(row.issueId) ?? [];
    if (images.length >= DETAIL_IMAGE_LIMIT) continue;
    images.push({ assetId: row.assetId, alt: row.originalFilename ?? null });
    map.set(row.issueId, images);
  }
  return map;
}

async function planDocumentMap(
  db: Db,
  companyId: string,
  issueIds: Array<string | null | undefined>,
  readCondition: SQL<boolean> = sql<boolean>`true`,
) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, PlanDocumentSummary>();
  const rows = await db
    .select({
      issueId: issueDocuments.issueId,
      title: documents.title,
      body: documents.latestBody,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .innerJoin(issues, and(eq(issueDocuments.issueId, issues.id), eq(issues.companyId, companyId)))
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(documents.companyId, companyId),
      eq(issueDocuments.key, "plan"),
      inArray(issueDocuments.issueId, ids),
      readCondition,
    ));
  return new Map(rows.map((row) => [row.issueId, { title: row.title, body: row.body }]));
}

async function blockingIssueMap(
  db: Db,
  companyId: string,
  blockedIssueIds: Array<string | null | undefined>,
  readCondition: SQL<boolean> = sql<boolean>`true`,
) {
  const ids = [...new Set(blockedIssueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, BlockingIssueSummary>();
  const rows = await db
    .select({
      blockedIssueId: issueRelations.relatedIssueId,
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(and(
      eq(issueRelations.companyId, companyId),
      eq(issues.companyId, companyId),
      eq(issueRelations.type, "blocks"),
      inArray(issueRelations.relatedIssueId, ids),
      isNull(issues.hiddenAt),
      readCondition,
    ))
    .orderBy(asc(issueRelations.relatedIssueId), asc(issueRelations.createdAt), asc(issueRelations.id));
  const map = new Map<string, BlockingIssueSummary>();
  for (const row of rows) {
    if (!map.has(row.blockedIssueId)) {
      map.set(row.blockedIssueId, { id: row.id, identifier: row.identifier, title: row.title });
    }
  }
  return map;
}

type BlockedWorkEdge = {
  fromIssueId: string | null;
  issueId: string;
};

/**
 * Counts open work held behind each blocker. The walk starts with explicit
 * dependents, then follows both further dependency edges and issue children.
 * Per-root visited sets make corrupt cycles harmless; the blocker analyzer's
 * existing traversal caps bound unusually large graphs.
 */
async function blockedWorkCountMap(db: Db, companyId: string, blockerIssueIds: string[]) {
  const rootIds = [...new Set(blockerIssueIds)];
  const seenByRoot = new Map(rootIds.map((rootId) => [rootId, new Set<string>()]));
  if (rootIds.length === 0) return new Map<string, number>();

  const loadEdges = async (fromIssueIds: string[], includeChildren: boolean) => {
    const rows: BlockedWorkEdge[] = [];
    for (const chunk of chunkValues(fromIssueIds, ATTENTION_GRAPH_QUERY_CHUNK_SIZE)) {
      const dependentRowsPromise: Promise<BlockedWorkEdge[]> = db
        .select({
          fromIssueId: issueRelations.issueId,
          issueId: issues.id,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.issueId, chunk),
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ));
      const childRowsPromise: Promise<BlockedWorkEdge[]> = includeChildren
        ? db
          .select({
            fromIssueId: issues.parentId,
            issueId: issues.id,
          })
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, chunk),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
          ))
        : Promise.resolve([]);
      const [dependentRows, childRows] = await Promise.all([dependentRowsPromise, childRowsPromise]);
      rows.push(...dependentRows, ...childRows);
    }
    return rows;
  };

  let rootsByFrontierId = new Map<string, Set<string>>();
  for (const edge of await loadEdges(rootIds, false)) {
    if (!edge.fromIssueId || edge.issueId === edge.fromIssueId) continue;
    const seen = seenByRoot.get(edge.fromIssueId);
    if (!seen || seen.size >= BLOCKER_ATTENTION_MAX_NODES || seen.has(edge.issueId)) continue;
    seen.add(edge.issueId);
    const roots = rootsByFrontierId.get(edge.issueId) ?? new Set<string>();
    roots.add(edge.fromIssueId);
    rootsByFrontierId.set(edge.issueId, roots);
  }

  for (let depth = 1; rootsByFrontierId.size > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextRootsByFrontierId = new Map<string, Set<string>>();
    const edges = await loadEdges([...rootsByFrontierId.keys()], true);
    for (const edge of edges) {
      if (!edge.fromIssueId) continue;
      const roots = rootsByFrontierId.get(edge.fromIssueId);
      if (!roots) continue;
      for (const rootId of roots) {
        if (edge.issueId === rootId) continue;
        const seen = seenByRoot.get(rootId);
        if (!seen || seen.size >= BLOCKER_ATTENTION_MAX_NODES || seen.has(edge.issueId)) continue;
        seen.add(edge.issueId);
        const nextRoots = nextRootsByFrontierId.get(edge.issueId) ?? new Set<string>();
        nextRoots.add(rootId);
        nextRootsByFrontierId.set(edge.issueId, nextRoots);
      }
    }
    rootsByFrontierId = nextRootsByFrontierId;
  }

  return new Map([...seenByRoot].map(([rootId, seen]) => [rootId, seen.size]));
}

/**
 * The task that blocks `issue` — never `issue` itself.
 *
 * Both blocker_attention call sites used to fall back to the blocked task's own
 * identity when no `blocks` relation was loaded, so every such row reported
 * "PAP-23 — Blocked by PAP-23". The UI renders that as a real dependency, which
 * tells an operator nothing and reads as a bug.
 *
 * Order: the loaded `blocks` relation, then an identifier sampled by
 * blockerAttention, and otherwise nothing — a null lets the row fall back to
 * its `whyNow` line, which is honest about not knowing the blocker.
 */
function resolveBlockingIssue(
  issue: { id: string; identifier: string | null },
  fromRelation: BlockingIssueSummary | undefined,
  sampledIdentifier?: string | null,
): BlockingIssueSummary | null {
  // A self-referential relation row would be corrupt data; treat it as unknown.
  if (fromRelation && fromRelation.id !== issue.id) return fromRelation;
  if (sampledIdentifier && sampledIdentifier !== issue.identifier && sampledIdentifier !== issue.id) {
    return { id: null, identifier: sampledIdentifier, title: null };
  }
  return null;
}

/**
 * Raw audience inputs a single source branch already has in hand. The resolver
 * reads these plus the per-issue context; it deliberately has no field for
 * `responsibleUserId`, the routine creator, a connected account, the agent
 * owner, or a manual routine starter, so it is structurally impossible to route
 * a card by any of them (PAP-749 plan §1, Rule 2).
 */
export type AttentionAudienceInput = {
  /** The issue the card hangs on, if any; keys the per-issue context lookup. */
  issueId: string | null;
  /** `issue_thread_interactions.addressee_user_id`. */
  addresseeUserId?: string | null;
  /** `approvals.requested_by_user_id`. */
  requestedByUserId?: string | null;
  /** A blocker/recovery owner that names a concrete user (never `"board"`). */
  ownerUserId?: string | null;
  /** The current execution review participant, when it is a user. */
  reviewParticipantUserId?: string | null;
  /** Company-operations alert (failed run, budget, agent error, join request, board-owned recovery). */
  companyScoped?: boolean;
  /**
   * A company alert that the budget owner also gets as a personal card (a
   * budget hard stop; PAP-749 plan §1, Rule 3). It still shows in Company.
   */
  escalatesToBudgetOwner?: boolean;
};

/**
 * Per-issue participation facts the resolver consults for the "issue chain"
 * steps. `instigatorUserId` is the creator of the nearest human-created
 * ancestor (reusing {@link humanCreatedIssueCondition}); it is `null` for work
 * that only agents or routines created.
 */
export type IssueAudienceContext = {
  conversationUserId: string | null;
  assigneeUserId: string | null;
  instigatorUserId: string | null;
  /** The card's own issue status; the stale rule reads it, the resolver does not. */
  issueStatus?: string | null;
  /**
   * The decision owner of the card's own project (task 1d), when it is still
   * an active member; the first escalation owner of Rule 2 step 5.
   */
  projectOwnerUserId?: string | null;
};

export const MAX_INSTIGATOR_CHAIN_DEPTH = 50;

/**
 * Company-level audience configuration (PAP-749 plan §1, Rule 2 step 5): the
 * default decision owner (task 1d-lite) and the budget owner (task 1d). The
 * project owner is per issue, on {@link IssueAudienceContext}.
 */
export type AttentionAudienceCompanyConfig = {
  /** The company's default decision owner, or `null` when none is set. */
  defaultDecisionOwnerUserId?: string | null;
  /** The company's budget owner, or `null` when none is set. */
  budgetOwnerUserId?: string | null;
};

/**
 * The escalation owner for a card (Rule 2 step 5): the project's decision
 * owner, else the company's default decision owner, else nobody.
 */
function escalationOwnerAudience(
  ctx: IssueAudienceContext | null,
  companyConfig: AttentionAudienceCompanyConfig,
): AttentionAudience | null {
  if (ctx?.projectOwnerUserId) return { kind: "user", userId: ctx.projectOwnerUserId, reason: "project_owner" };
  if (companyConfig.defaultDecisionOwnerUserId) {
    return { kind: "user", userId: companyConfig.defaultDecisionOwnerUserId, reason: "escalation_owner" };
  }
  return null;
}

/**
 * Compute where a card shows (PAP-749 plan §1, Rule 2). Apply the first step in
 * the table that yields a user; otherwise the card goes to an escalation owner
 * (step 5: the project's decision owner, then the company's default decision
 * owner); failing that it goes to the claimable Unassigned pool (step 6).
 * Placement only — the resolver policy still gates who may act.
 */
export function resolveAttentionAudience(
  input: AttentionAudienceInput,
  ctx: IssueAudienceContext | null,
  companyConfig: AttentionAudienceCompanyConfig = {},
): AttentionAudience {
  // Company-operations alerts belong to the operator "Company" view. A budget
  // hard stop also goes to the budget owner, and Company still shows it (Rule 3).
  if (input.companyScoped) {
    if (input.escalatesToBudgetOwner && companyConfig.budgetOwnerUserId) {
      return { kind: "user", userId: companyConfig.budgetOwnerUserId, reason: "budget_owner", alsoInCompany: true };
    }
    return { kind: "company", userId: null, reason: "none" };
  }
  // Step 1: an explicit addressee always wins, even on an automated task.
  if (input.addresseeUserId) return { kind: "user", userId: input.addresseeUserId, reason: "addressee" };
  // Source-specific owners that stand in for an explicit recipient.
  if (input.requestedByUserId) return { kind: "user", userId: input.requestedByUserId, reason: "requester" };
  if (input.ownerUserId) return { kind: "user", userId: input.ownerUserId, reason: "assignee" };
  // Step 2: the chat user.
  if (ctx?.conversationUserId) return { kind: "user", userId: ctx.conversationUserId, reason: "conversation" };
  // Step 3: the current review participant, or the human assignee.
  if (input.reviewParticipantUserId) return { kind: "user", userId: input.reviewParticipantUserId, reason: "reviewer" };
  if (ctx?.assigneeUserId) return { kind: "user", userId: ctx.assigneeUserId, reason: "assignee" };
  // Step 4: the instigator — the human who created the original work, up the parent chain.
  if (ctx?.instigatorUserId) return { kind: "user", userId: ctx.instigatorUserId, reason: "instigator" };
  // Step 5: an escalation owner, so an ownerless card lands on a real person's
  // "For you" list instead of waiting in Unassigned.
  const escalation = escalationOwnerAudience(ctx, companyConfig);
  if (escalation) return escalation;
  // Step 6: no owner — the card goes to the claimable Unassigned pool.
  return { kind: "pool", userId: null, reason: "none" };
}

/** Whether a resolved audience belongs in the requested view (PAP-749 plan §1, Rule 3). */
export function audienceMatchesView(
  audience: AttentionAudience,
  view: AttentionFeedView,
  userId: string | null | undefined,
): boolean {
  switch (view) {
    // `all` is the pre-PAP-749 superset; the existing per-source filters already
    // shaped `collected`, so every surviving item belongs in it. `archived` is
    // every card the person hid themselves, whatever its audience (plan §3);
    // the caller selects it by the person's own dismissal, not by audience.
    case "all":
    case "archived":
      return true;
    case "mine":
      return audience.kind === "user" && audience.userId != null && audience.userId === userId;
    case "unassigned":
      return audience.kind === "pool";
    case "company":
      // A critical incident with a personal owner still shows here (Rule 3).
      return audience.kind === "company" || audience.alsoInCompany === true;
  }
}

const DAY_MS = 86_400_000;
/** Rule 10: a card with no important change for this long is stale. */
export const ATTENTION_STALE_AFTER_DAYS = 30;
/** Recommendation (e): an Unassigned card with no owner for this long moves to Company. */
export const ATTENTION_UNOWNED_ESCALATE_AFTER_DAYS = 7;
/** Rule 10: a decision is stale once this share of its time limit is gone. */
const DECISION_STALE_ELAPSED_RATIO = 0.8;

/**
 * What counts as an important change for one card (PAP-749 plan §2, Rule 9).
 * `content` names the proposal, its options, or the state a person decides on;
 * `since` is when that content last changed. Log entries, automatic retries,
 * unrelated comments and assignee changes are deliberately not part of it.
 * `required` marks an approval or governed request: the gate stays closed until
 * a person answers, so a stale one escalates instead of fading.
 */
export type AttentionChangeBasis = {
  content: unknown;
  since: Date | string;
  required?: boolean;
};

const FINGERPRINT_FOR_VIEWER = "me";
const FINGERPRINT_FOR_OTHER = "other";

/**
 * The opaque `AttentionItem.changeFingerprint`: a hash of the important content
 * plus whether the card is addressed to the viewer, so "the card comes to you
 * again" counts as a change (Rule 9) while a hand-off away from you does not.
 */
export function attentionChangeFingerprint(input: {
  sourceKind: AttentionSourceKind;
  content: unknown;
  forViewer: boolean;
}): string {
  const hash = normalizedContentHash({ v: 1, sourceKind: input.sourceKind, content: input.content ?? null })
    .slice("sha256:".length, "sha256:".length + 32);
  return `${hash}.${input.forViewer ? FINGERPRINT_FOR_VIEWER : FINGERPRINT_FOR_OTHER}`;
}

/**
 * Whether a stored dismissal still hides the card. `null` means the row has no
 * fingerprint (saved before Rule 9), so the caller keeps the activity-time
 * rule. Otherwise the card stays hidden until its content changes or it is
 * newly addressed to the viewer.
 */
export function dismissalCoversChange(stored: string | null | undefined, current: string): boolean | null {
  if (!stored) return null;
  const [storedHash, storedTarget] = stored.split(".");
  const [currentHash, currentTarget] = current.split(".");
  if (storedHash !== currentHash) return false;
  return !(currentTarget === FINGERPRINT_FOR_VIEWER && storedTarget !== FINGERPRINT_FOR_VIEWER);
}

/**
 * Rule 10: why a card is stale, if it is. The first matching reason wins. The
 * label only moves the card to the Stale group; nothing here withdraws it.
 */
export function resolveAttentionStale(input: {
  sourceKind: AttentionSourceKind;
  issueStatus: string | null | undefined;
  since: Date | string;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
  audience: AttentionAudience;
  now: number;
}): AttentionStale | null {
  if (input.issueStatus === "done" || input.issueStatus === "cancelled") return { reason: "issue_closed" };
  if (input.sourceKind === "decision" && input.expiresAt) {
    const created = timestamp(input.createdAt);
    const window = timestamp(input.expiresAt) - created;
    if (window > 0 && input.now - created >= window * DECISION_STALE_ELAPSED_RATIO) {
      return { reason: "decision_expiring" };
    }
  }
  const age = input.now - timestamp(input.since);
  if (age >= ATTENTION_STALE_AFTER_DAYS * DAY_MS) return { reason: "aged" };
  if (input.audience.kind === "pool" && age >= ATTENTION_UNOWNED_ESCALATE_AFTER_DAYS * DAY_MS) {
    return { reason: "unowned" };
  }
  return null;
}

/**
 * Where an old card goes so it never disappears (Rule 10 and recommendation
 * (e)). An Unassigned card with no owner for 7 days moves to Company. A
 * required card (approval or governed request) waiting 30 days moves to its
 * escalation owner (the project's decision owner, else the default decision
 * owner), or to Company when there is none. Placement only: the card stays
 * pending and its gate stays closed.
 */
export function escalateStaleAudience(input: {
  audience: AttentionAudience;
  since: Date | string;
  required: boolean;
  now: number;
  companyConfig?: AttentionAudienceCompanyConfig;
  /** The card's issue context, for its project's decision owner. */
  ctx?: IssueAudienceContext | null;
}): AttentionAudience {
  const age = input.now - timestamp(input.since);
  if (input.audience.kind === "pool" && age >= ATTENTION_UNOWNED_ESCALATE_AFTER_DAYS * DAY_MS) {
    return { kind: "company", userId: null, reason: "none" };
  }
  if (input.required && input.audience.kind === "user" && age >= ATTENTION_STALE_AFTER_DAYS * DAY_MS) {
    return escalationOwnerAudience(input.ctx ?? null, input.companyConfig ?? {})
      ?? { kind: "company", userId: null, reason: "none" };
  }
  return input.audience;
}

/**
 * What a card says about the obligation it belongs to (PAP-749 plan §2, Rule
 * 11), captured per card during collection. `anchor` marks the card that makes
 * the obligation real: the approval itself, or a card for the blocked task. A
 * key with no anchor card in the feed (only failed runs, or a review whose
 * approval is not shown) forms no obligation.
 */
export type AttentionObligationHint = { key: string; anchor: boolean };

/** Lower leads: the card that carries the one action for its obligation. */
function obligationLeadRank(item: AttentionItem) {
  switch (item.sourceKind) {
    // A budget hard stop answers its override approval: Raise limit approves
    // it and Keep paused rejects it (`budgets.resolveIncident`; PAP-768).
    case "budget_alert":
      return 0;
    case "approval":
      return 1;
    // The failed run carries the working action (Retry) for the task it blocks.
    case "failed_run":
      return 2;
    case "blocker_attention":
      return item.dedupKey.startsWith("blocked-owner:") ? 3 : 4;
    default:
      return 5;
  }
}

/**
 * Join the cards that are one obligation (PAP-749 plan §2, Rule 11) and pick
 * the lead: a budget hard stop over its override approval (PAP-768), else the
 * approval, else the failed run that caused the block, else the blocked task.
 * Every member keeps its own record (the server keeps all the evidence); the
 * members share one placement, so the obligation shows in one view and counts
 * once. A failed run, a company alert that is not a required gate, goes with
 * the work it blocks, to that person. A hard stop keeps its own placement: the
 * budget owner, else Company. Mutates `items`.
 */
export function assignAttentionObligations(
  items: AttentionItem[],
  hintByDedupKey: ReadonlyMap<string, AttentionObligationHint>,
) {
  const groups = new Map<string, { members: AttentionItem[]; anchored: boolean }>();
  for (const item of items) {
    const hint = hintByDedupKey.get(item.dedupKey);
    if (!hint) continue;
    const group = groups.get(hint.key) ?? { members: [], anchored: false };
    group.members.push(item);
    group.anchored ||= hint.anchor;
    groups.set(hint.key, group);
  }
  for (const [key, group] of groups) {
    if (!group.anchored || group.members.length < 2) continue;
    const [lead, ...evidence] = [...group.members].sort((left, right) =>
      obligationLeadRank(left) - obligationLeadRank(right) || compareAttentionItems(left, right));
    const audience = lead!.audience.kind === "company" && !lead!.required && lead!.sourceKind !== "budget_alert"
      ? evidence.find((member) => member.audience.kind === "user")?.audience ?? lead!.audience
      : lead!.audience;
    for (const member of group.members) {
      member.obligationKey = key;
      member.obligationLeadId = lead!.id;
      member.audience = audience;
    }
  }
}

function isObligationEvidence(item: AttentionItem) {
  return item.obligationLeadId != null && item.obligationLeadId !== item.id;
}

/**
 * Put each obligation's evidence right after its lead, in the lead's place, so
 * a page keeps them together. Evidence whose lead is not in `items` stays put.
 */
function keepObligationsTogether(items: AttentionItem[]) {
  const evidenceByLeadId = new Map<string, AttentionItem[]>();
  for (const item of items) {
    if (!isObligationEvidence(item)) continue;
    evidenceByLeadId.set(item.obligationLeadId!, [...(evidenceByLeadId.get(item.obligationLeadId!) ?? []), item]);
  }
  if (evidenceByLeadId.size === 0) return items;
  const ids = new Set(items.map((item) => item.id));
  const ordered: AttentionItem[] = [];
  for (const item of items) {
    if (isObligationEvidence(item) && ids.has(item.obligationLeadId!)) continue;
    ordered.push(item, ...(evidenceByLeadId.get(item.id) ?? []));
  }
  return ordered;
}

/**
 * Load the per-issue audience context for `startIssueIds`: the chat user and
 * human assignee of each start issue, plus the instigator found by walking the
 * parent chain to the nearest human-created ancestor. The human-created test is
 * the shared {@link humanCreatedIssueCondition} predicate (no copy), so this
 * never attributes agent- or routine-created work to a person.
 */
export async function resolveIssueAudienceContextMap(
  db: Db,
  companyId: string,
  startIssueIds: Array<string | null | undefined>,
): Promise<Map<string, IssueAudienceContext>> {
  const starts = [...new Set(startIssueIds.filter((value): value is string => Boolean(value)))];
  if (starts.length === 0) return new Map();

  type ChainNode = { parentId: string | null; instigatorSelf: string | null };
  const chain = new Map<string, ChainNode>();
  const starterContext = new Map<string, {
    conversationUserId: string | null;
    assigneeUserId: string | null;
    issueStatus: string;
    projectId: string | null;
  }>();

  let frontier = starts;
  for (let depth = 0; depth <= MAX_INSTIGATOR_CHAIN_DEPTH && frontier.length > 0; depth += 1) {
    const need = [...new Set(frontier)].filter((id) => !chain.has(id));
    if (need.length === 0) break;
    const rows = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        status: issues.status,
        conversationUserId: issues.conversationUserId,
        assigneeUserId: issues.assigneeUserId,
        createdByUserId: issues.createdByUserId,
        projectId: issues.projectId,
        humanCreated: humanCreatedIssueCondition(),
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, need)));
    for (const row of rows) {
      chain.set(row.id, {
        parentId: row.parentId,
        instigatorSelf: row.humanCreated ? row.createdByUserId : null,
      });
      if (depth === 0) {
        starterContext.set(row.id, {
          conversationUserId: row.conversationUserId,
          assigneeUserId: row.assigneeUserId,
          issueStatus: row.status,
          projectId: row.projectId,
        });
      }
    }
    frontier = rows.map((row) => row.parentId).filter((id): id is string => Boolean(id));
  }

  // Task 1d: the decision owner of each start issue's own project, kept only
  // while that person is an active member (one query for all projects).
  const projectIds = [...new Set([...starterContext.values()]
    .map((context) => context.projectId)
    .filter((id): id is string => Boolean(id)))];
  const projectOwnerRows = projectIds.length > 0
    ? await db
      .select({ id: projects.id, decisionOwnerUserId: projects.decisionOwnerUserId })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
    : [];
  const activeProjectOwners = await activeMemberUserIds(
    db,
    companyId,
    projectOwnerRows.map((row) => row.decisionOwnerUserId),
  );
  const projectOwnerById = new Map(projectOwnerRows.map((row) => [
    row.id,
    row.decisionOwnerUserId && activeProjectOwners.has(row.decisionOwnerUserId) ? row.decisionOwnerUserId : null,
  ]));

  const result = new Map<string, IssueAudienceContext>();
  for (const start of starts) {
    let cursor: string | null = start;
    let instigatorUserId: string | null = null;
    for (let steps = 0; cursor && steps <= MAX_INSTIGATOR_CHAIN_DEPTH; steps += 1) {
      const node = chain.get(cursor);
      if (!node) break;
      if (node.instigatorSelf) {
        instigatorUserId = node.instigatorSelf;
        break;
      }
      cursor = node.parentId;
    }
    const context = starterContext.get(start);
    result.set(start, {
      conversationUserId: context?.conversationUserId ?? null,
      assigneeUserId: context?.assigneeUserId ?? null,
      instigatorUserId,
      issueStatus: context?.issueStatus ?? null,
      projectOwnerUserId: context?.projectId ? projectOwnerById.get(context.projectId) ?? null : null,
    });
  }
  return result;
}

/** The task is locked first, as in resolution, before locking its interaction.
 * Read access and mutation authority are rechecked against that task snapshot. */
async function lockAttentionRoutingSource(db: Db, companyId: string, sourceId: string, actor: AuthorizationActor) {
  if (actor.type !== "board" || !actor.userId) throw forbidden("A signed-in user is required to route a request.");
  const readCondition = await issueReadSqlCondition(db, actor);
  const [observed] = await db.select({ issueId: issues.id,
    addresseeUserId: issueThreadInteractions.addresseeUserId, addresseeAgentId: issueThreadInteractions.addresseeAgentId,
  }).from(issueThreadInteractions).innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId)).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.id, sourceId), eq(issues.companyId, companyId), readCondition,
  )).limit(1);
  if (!observed) throw notFound("Card not found");
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.id, observed.issueId), eq(issues.companyId, companyId), readCondition,
  )).for("update");
  if (!issue) throw notFound("Card not found");
  const write = await authorizationService(db).decide({ actor, action: "issue:mutate", resource: { ...issue, type: "issue", issueId: issue.id } });
  if (!write.allowed) throw forbidden("Issue write access is required to route a request.");
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issue.id), eq(issueThreadInteractions.id, sourceId),
  )).for("update");
  if (!interaction) throw notFound("Card not found");
  return { issue, interaction, observed };
}

export function attentionService(db: Db, serviceOptions: AttentionServiceOptions = {}) {
  const openDecisionLimit = Math.min(
    Math.max(Math.trunc(serviceOptions.openDecisionLimit ?? OPEN_DECISION_DEFAULT_LIMIT), 1),
    OPEN_DECISION_MAX_LIMIT,
  );
  async function list(companyId: string, options: AttentionListOptions = {}, questionIssueIds?: readonly string[]): Promise<AttentionFeed> {
      if (options.all && !options.queue && !options.allowUnscopedAll) {
        throw badRequest("all requires a queue filter");
      }
      const readCondition = options.actor
        ? await issueReadSqlCondition(db, options.actor)
        : sql<boolean>`true`;
      const [companyConfig, dismissals] = await Promise.all([
        loadCompanyAttentionConfig(db, companyId),
        dismissalByKey(db, companyId, options.userId),
      ]);
      const prefix = companyConfig.prefix;
      const includeDismissed = options.includeDismissed === true;
      const now = serviceOptions.now?.() ?? Date.now();
      const countsOnly = options.countsOnly === true;
      const summaryOnly = options.summaryOnly === true || countsOnly;
      const loadImages = (...args: Parameters<typeof issueImageMap>) => summaryOnly
        ? Promise.resolve(new Map<string, AttentionDetailImage[]>()) : issueImageMap(...args);
      // The tasks of these ids that the reader can see in the feed. A count
      // needs the same answer, without each task's project and workspace.
      const loadIssues = (issueIds: Array<string | null | undefined>, includeConversations = false) =>
        issueSummaryMap(db, companyId, issueIds, readCondition, includeConversations, !summaryOnly);
      const view: AttentionFeedView = options.view ?? "all";
      const collected: AttentionItem[] = [];
      // Raw audience inputs and important-change facts captured per item during
      // collection, keyed by dedup key, then resolved once after dedup (PAP-749
      // plan §1, Rule 2; §2, Rules 9-10). Personal hiding needs the resolved
      // audience, so it is applied in the same post-pass.
      const audienceInputByDedupKey = new Map<string, AttentionAudienceInput>();
      const changeBasisByDedupKey = new Map<string, AttentionChangeBasis>();
      const obligationHintByDedupKey = new Map<string, AttentionObligationHint>();

      const add = (
        item: AttentionItem,
        audienceInput: AttentionAudienceInput,
        change: AttentionChangeBasis,
        obligation?: AttentionObligationHint | null,
      ) => {
        audienceInputByDedupKey.set(item.dedupKey, audienceInput);
        changeBasisByDedupKey.set(item.dedupKey, change);
        if (obligation) obligationHintByDedupKey.set(item.dedupKey, obligation);
        collected.push(item);
      };

      if (!questionIssueIds && !options.excludeSources?.includes("approval")) {
        const pendingApprovals = await db
          .select({
            id: approvals.id,
            linkedIssueId: firstApprovalIssueId(),
            type: approvals.type,
            status: approvals.status,
            requestedByAgentId: approvals.requestedByAgentId,
            requestedByUserId: approvals.requestedByUserId,
            changeContent: sql<string>`md5(jsonb_build_object('type', ${approvals.type}, 'payload', ${approvals.payload})::text)`,
            payload: summaryOnly ? sql<Record<string, unknown>>`'{}'::jsonb` : approvals.payload,
            createdAt: approvals.createdAt,
            updatedAt: approvals.updatedAt,
          })
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"), approvalExecutionIssueCondition()))
          .orderBy(desc(approvals.updatedAt), desc(approvals.id));

        const readableApprovalIssues = await loadIssues(pendingApprovals.map((row) => row.linkedIssueId));

        for (const approval of pendingApprovals) {
          const linkedIssueId = approval.linkedIssueId ?? null;
          if (linkedIssueId && !readableApprovalIssues.has(linkedIssueId)) continue;
          const dedupKey = `approval:${approval.id}`;
          const title = approvalTitle(approval.type, approval.payload);
          add(createItem({
            companyId,
            sourceKind: "approval",
            subject: {
              kind: "approval",
              id: approval.id,
              companyId,
              title,
              identifier: null,
              status: approval.status,
              href: `/${prefix}/approvals/${approval.id}`,
              metadata: {
                type: approval.type,
                requestedByAgentId: approval.requestedByAgentId,
                requestedByUserId: approval.requestedByUserId,
                issueId: approval.linkedIssueId ?? null,
              },
            },
            whyNow: "Approval is pending a board decision.",
            decisionVerbs: decisionVerbs(
              { id: "approve", label: "Approve", description: "Approve the request." },
              { id: "reject", label: "Reject", description: "Reject the request." },
              { id: "request_revision", label: "Request revision", description: "Send the request back for changes." },
            ),
            // Every approval, board approvals included, is answered on the card (PAP-775).
            inlineResolvable: true,
            entryRule: "approvals.status = 'pending'",
            exitRule: "Approval leaves pending status.",
            dedupKey,
            severity: "medium",
            activityAt: toIso(approval.updatedAt),
            createdAt: toIso(approval.createdAt),
            updatedAt: toIso(approval.updatedAt),
            relatedIssue: null,
            detail: approvalDetail(approval.type, approval.payload),
          }), { issueId: linkedIssueId, requestedByUserId: approval.requestedByUserId }, {
            // `updatedAt` moves only when the request (re)enters pending, e.g. a
            // resubmission with a revised proposal; comments do not touch it.
            content: approval.changeContent,
            since: approval.updatedAt,
            required: true,
          }, { key: `approval:${approval.id}`, anchor: true });
        }

      }

      const interactionRows = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          changeContent: sql<string>`md5(jsonb_build_object('kind', ${issueThreadInteractions.kind}, 'payload', ${issueThreadInteractions.payload})::text)`,
          payload: summaryOnly ? sql<Record<string, unknown>>`jsonb_build_object('target', ${issueThreadInteractions.payload}->'target', 'qualityReview', ${issueThreadInteractions.payload}->'qualityReview', 'toolAction', ${issueThreadInteractions.payload}->'toolAction', 'secretProposal', ${issueThreadInteractions.payload}->'secretProposal', 'connectionAuthorization', ${issueThreadInteractions.payload}->'connectionAuthorization')` : issueThreadInteractions.payload,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          addresseeUserId: issueThreadInteractions.addresseeUserId,
          createdByAgentId: issueThreadInteractions.createdByAgentId,
          createdByUserId: issueThreadInteractions.createdByUserId,
          requestedResolverPolicy: issueThreadInteractions.requestedResolverPolicy,
          effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
          resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
          effectiveResolverPolicySource: issueThreadInteractions.effectiveResolverPolicySource,
          createdAt: issueThreadInteractions.createdAt,
          updatedAt: issueThreadInteractions.updatedAt,
          // Rule 9: the same "current request" predicate Mine and runs use. Old
          // ordinary questions and requests a person deferred (interaction
          // `dismissedAt`) leave the list; they stay answerable on the task.
          active: sql<boolean>`${activeIssueInteractionCondition()}`,
          // Governed requests keep their gate; a stale one escalates (Rule 10).
          required: sql<boolean>`not ${deferrableInteractionCondition()}`,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
          questionIssueIds ? inArray(issueThreadInteractions.issueId, [...questionIssueIds]) : undefined,
          questionIssueIds ? eq(issueThreadInteractions.kind, "ask_user_questions") : undefined,
        ))
        .orderBy(desc(issueThreadInteractions.updatedAt), desc(issueThreadInteractions.id));
      // Addressee invokability needs the org graph; the audience line also needs
      // the creator's name whenever the effective policy excludes it, so a
      // creator-excluding row pulls the roster in too (PAP-17287).
      const needsCompanyAgents = interactionRows.some((row) =>
        row.addresseeAgentId !== null
        || canonicalizeStoredResolverPolicy(row.effectiveResolverPolicy, row.resolverPolicyProvenance) === "not_creator"
      );
      const companyAgentRows: AgentOrgRow[] = needsCompanyAgents
        ? await db
          .select({
            id: agents.id,
            companyId: agents.companyId,
            name: agents.name,
            reportsTo: agents.reportsTo,
            status: agents.status,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId))
        : [];
      const companyAgentMap = new Map(companyAgentRows.map((agent) => [agent.id, agent]));
      const boardInteractionRows = interactionRows.filter((row) =>
        row.addresseeAgentId === null ||
          !evaluateAgentInvokability(companyAgentMap.get(row.addresseeAgentId), companyAgentRows).invokable
      );
      const visibleInteractionRows = collapsePendingConfirmationsToNewest(boardInteractionRows, await loadNewestSettledConfirmationAt(
        db, companyId, boardInteractionRows.filter((row) => row.kind === "request_confirmation").map((row) => row.issueId),
      )).filter(row => row.active);
      const [interactionIssueMap, interactionImageMap, interactionPlanDocumentMap] = await Promise.all([
        // A pending human request remains actionable in a persistent chat even
        // though its idle container is intentionally absent from work queues.
        loadIssues(visibleInteractionRows.map((row) => row.issueId), true),
        loadImages(db, companyId, visibleInteractionRows.map((row) => row.issueId), readCondition),
        summaryOnly ? Promise.resolve(new Map<string, PlanDocumentSummary>())
          : planDocumentMap(db, companyId, visibleInteractionRows.map((row) => row.issueId), readCondition),
      ]);

      for (const interaction of visibleInteractionRows) {
        const issue = interactionIssueMap.get(interaction.issueId) ?? null;
        if (!issue) continue;
        const payload = readRecord(interaction.payload);
        const detail = summaryOnly ? null : interactionDetail({
          kind: interaction.kind,
          payload,
          issue,
          planDocument: interactionPlanDocumentMap.get(interaction.issueId) ?? null,
          images: issueImages(interactionImageMap, interaction.issueId),
        });
        const isPlanTarget = interaction.kind === "request_confirmation" && isPlanDocumentTarget(payload);
        const dedupKey = `interaction:${interaction.id}`;
        add(createItem({
          companyId,
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: interaction.id,
            companyId,
            title: isPlanTarget && issue ? `Plan approval - ${issue.title}` : interaction.title ?? interaction.summary ?? interactionLabel(interaction.kind),
            identifier: null,
            status: interaction.status,
            href: issue ? `${issueHref(prefix, issue)}#interaction-${interaction.id}` : null,
            metadata: {
              kind: interaction.kind,
              issueId: interaction.issueId,
              createdByAgentId: interaction.createdByAgentId,
              createdByUserId: interaction.createdByUserId,
              isPlanTarget,
              targetDocumentKey: isPlanTarget ? "plan" : null,
              requestKind: interactionRequestKind(interaction.kind, payload),
            },
          },
          whyNow: `${interactionLabel(interaction.kind)} on an issue thread.`,
          decisionVerbs: interactionVerbs(interaction.kind, payload),
          inlineResolvable: true,
          entryRule: "issue_thread_interactions.status = 'pending'",
          exitRule: "Interaction resolves, expires, fails, or is cancelled.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(interaction.updatedAt),
          createdAt: toIso(interaction.createdAt),
          updatedAt: toIso(interaction.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          ...issueContext(issue),
          detail,
          resolverAudience: interactionResolverAudience(
            interaction,
            (agentId) => companyAgentMap.get(agentId)?.name ?? null,
          ),
        }), { issueId: interaction.issueId, addresseeUserId: interaction.addresseeUserId }, {
          content: interaction.changeContent,
          since: interaction.createdAt,
          required: interaction.required,
        });
      }

      if (!questionIssueIds) {
      const openDecisionQuery = db.select({
        id: decisions.id,
        bundleId: decisions.bundleId,
        originAgentId: decisions.originAgentId,
        ruleKey: decisions.ruleKey,
        title: decisions.title,
        changeContent: sql<string>`md5(jsonb_build_object('title', ${decisions.title}, 'body', ${decisions.body}, 'options', ${decisions.options})::text)`,
        body: summaryOnly ? sql<string>`''` : decisions.body,
        options: decisions.options,
        status: decisions.status,
        expiresAt: decisions.expiresAt,
        originIssueId: decisions.originIssueId,
        createdAt: decisions.createdAt,
        updatedAt: decisions.updatedAt,
      }).from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")))
        .orderBy(desc(decisions.updatedAt), desc(decisions.id));
      const openDecisions = options.all
        ? await openDecisionQuery
        : await openDecisionQuery.limit(openDecisionLimit);
      // Bundle titles let the feed render a single "Agent proposed N decisions"
      // group header over sibling decisions (v1 still decides each independently).
      const bundleIds = [...new Set(openDecisions.map((decision) => decision.bundleId).filter((value): value is string => Boolean(value)))];
      const bundleTitleMap = new Map<string, string>();
      const [decisionIssueMap, bundleRows] = await Promise.all([
        loadIssues(openDecisions.map((decision) => decision.originIssueId)),
        // A count does not show the title of a bundle.
        bundleIds.length > 0 && !summaryOnly
          ? db.select({ id: decisionBundles.id, title: decisionBundles.title })
            .from(decisionBundles).where(and(eq(decisionBundles.companyId, companyId), inArray(decisionBundles.id, bundleIds)))
          : Promise.resolve([]),
      ]);
      for (const row of bundleRows) bundleTitleMap.set(row.id, row.title);
      for (const decision of openDecisions) {
        const issue = decisionIssueMap.get(decision.originIssueId) ?? null;
        if (decision.originIssueId && !issue) continue;
        add(createItem({
          companyId,
          sourceKind: "decision",
          subject: { kind: "decision", id: decision.id, companyId, title: decision.title, identifier: null, status: decision.status,
            href: `/${prefix}/decisions?decisionId=${decision.id}`,
            metadata: { originIssueId: decision.originIssueId, originAgentId: decision.originAgentId, bundleId: decision.bundleId,
              bundleTitle: decision.bundleId ? bundleTitleMap.get(decision.bundleId) ?? null : null } },
          whyNow: "An agent decision is waiting for a board response.",
          decisionVerbs: decisionVerbs({ id: "decide", label: "Review", description: "Review and choose an option." }),
          inlineResolvable: true,
          entryRule: "decisions.status = 'open'",
          exitRule: "Decision is decided, expired, or cancelled.",
          dedupKey: `decision:${decision.id}`,
          severity: "medium",
          expiresAt: decision.expiresAt ? toIso(decision.expiresAt) : null,
          ruleKey: decision.ruleKey,
          activityAt: toIso(decision.updatedAt),
          createdAt: toIso(decision.createdAt),
          updatedAt: toIso(decision.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          ...issueContext(issue),
          detail: { kind: "generic", summaryExcerpt: decision.body.slice(0, DETAIL_EXCERPT_LENGTH), images: [] },
        }), { issueId: decision.originIssueId }, {
          content: decision.changeContent,
          since: decision.createdAt,
        });
      }

      if (!options.excludeSources?.includes("join_request")) {
      const pendingJoins = await db
        .select({
          id: joinRequests.id,
          requestType: joinRequests.requestType,
          status: joinRequests.status,
          requestingUserId: joinRequests.requestingUserId,
          requestEmailSnapshot: joinRequests.requestEmailSnapshot,
          agentName: joinRequests.agentName,
          adapterType: joinRequests.adapterType,
          createdAt: joinRequests.createdAt,
          updatedAt: joinRequests.updatedAt,
        })
        .from(joinRequests)
        .innerJoin(invites, eq(joinRequests.inviteId, invites.id))
        .where(and(
          eq(joinRequests.companyId, companyId),
          eq(invites.companyId, companyId),
          eq(joinRequests.status, "pending_approval"),
        ))
        .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.id));

      for (const join of pendingJoins) {
        const label = join.requestType === "agent"
          ? join.agentName ?? "Agent join request"
          : join.requestEmailSnapshot ?? join.requestingUserId ?? "Human join request";
        const dedupKey = `join:${join.id}`;
        add(createItem({
          companyId,
          sourceKind: "join_request",
          subject: {
            kind: "join_request",
            id: join.id,
            companyId,
            title: label,
            identifier: null,
            status: join.status,
            href: `/${prefix}/settings/access`,
            metadata: {
              requestType: join.requestType,
              requestingUserId: join.requestingUserId,
              adapterType: join.adapterType,
            },
          },
          whyNow: "Join request is pending approval.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve this join request." },
            { id: "reject", label: "Reject", description: "Reject this join request." },
          ),
          inlineResolvable: true,
          entryRule: "join_requests.status = 'pending_approval'",
          exitRule: "Join request is approved or rejected.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(join.updatedAt),
          createdAt: toIso(join.createdAt),
          updatedAt: toIso(join.updatedAt),
          relatedIssue: null,
          detail: genericDetail(label, []),
        }), { issueId: null, companyScoped: true }, {
          content: { requestType: join.requestType },
          since: join.createdAt,
        });
      }

      }

      const recoveryRows = await db
        .select()
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.companyId, companyId),
          recoveryActionAttentionCondition(),
        ))
        .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
      const [recoveryIssueMap, recoveryImageMap] = await Promise.all([
        loadIssues(recoveryRows.flatMap((row) => [row.sourceIssueId, row.recoveryIssueId])),
        loadImages(db, companyId, recoveryRows.map((row) => row.sourceIssueId), readCondition),
      ]);

      for (const recovery of recoveryRows) {
        const sourceIssue = recoveryIssueMap.get(recovery.sourceIssueId) ?? null;
        if (!sourceIssue) continue;
        const recoveryIssue = recovery.recoveryIssueId ? recoveryIssueMap.get(recovery.recoveryIssueId) ?? null : null;
        const dedupKey = `recovery:${recovery.kind}:${recovery.sourceIssueId}:${recovery.cause}:${recovery.fingerprint}`;
        add(createItem({
          companyId,
          sourceKind: "recovery_action",
          subject: {
            kind: "recovery_action",
            id: recovery.id,
            companyId,
            title: recovery.nextAction,
            identifier: null,
            status: recovery.status,
            href: recoveryIssue ? issueHref(prefix, recoveryIssue) : sourceIssue ? issueHref(prefix, sourceIssue) : null,
            metadata: {
              kind: recovery.kind,
              cause: recovery.cause,
              ownerType: recovery.ownerType,
              ownerUserId: recovery.ownerUserId,
              sourceIssueId: recovery.sourceIssueId,
              recoveryIssueId: recovery.recoveryIssueId,
            },
          },
          whyNow: recovery.status === "escalated"
            ? "Recovery action escalated to a human owner."
            : "Recovery action is assigned to a human owner.",
          // PAP-749 Rule 7: resolving, reassigning or cancelling a recovery
          // also sets the task's next status, so the card links to the recovery
          // control on the task instead of offering verbs it cannot complete.
          decisionVerbs: decisionVerbs(
            { id: "open_recovery", label: "Open recovery", description: "Resolve, reassign or cancel this recovery on its task." },
          ),
          inlineResolvable: false,
          entryRule: "issue_recovery_actions.status in ('active','escalated') and owner_type in ('user','board')",
          exitRule: "Recovery action resolves, is cancelled, or moves back to an agent/system owner.",
          dedupKey,
          severity: recovery.status === "escalated" ? "high" : "medium",
          activityAt: toIso(recovery.updatedAt),
          createdAt: toIso(recovery.createdAt),
          updatedAt: toIso(recovery.updatedAt),
          relatedIssue: sourceIssue ? issueSubject(prefix, sourceIssue) : null,
          ...issueContext(sourceIssue),
          detail: genericDetail(recovery.nextAction, issueImages(recoveryImageMap, recovery.sourceIssueId)),
        }), {
          issueId: recovery.sourceIssueId,
          ownerUserId: recovery.ownerType === "user" ? recovery.ownerUserId : null,
          companyScoped: recovery.ownerType === "board",
        }, {
          // Escalation and a new next action are important; retry attempts
          // that only move `updatedAt` are not.
          content: { status: recovery.status, nextAction: recovery.nextAction },
          since: recovery.createdAt,
        });
      }

      // A count needs the blocked tasks that the task list returns, in the
      // order of the list, and the blocker attention of each one. It asks the
      // list for those rows alone and classifies them with the function that
      // the full list calls.
      const blockedIssues = summaryOnly
        ? await issueService(db).listBlockerAttentionRoots(companyId, { status: "blocked", readCondition })
        : await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true, readCondition });
      const countedBlockerAttention = summaryOnly
        ? await issueService(db).listBlockerAttention(companyId, blockedIssues)
        : null;
      type BlockedAttentionIssue = IssueSubjectRow & {
        blockerAttention?: {
          state?: string;
          sampleStalledBlockerIdentifier?: string | null;
          sampleBlockerIdentifier?: string | null;
          blockingTreeLive?: boolean;
          terminalBlockerIssueId?: string | null;
        } | null;
        unblockDescriptor?: { owner: { userId: string } | { agentId: string } | "board"; action: string } | null;
        blockedTransitionAt?: Date | null;
      };
      const typedBlockedIssues = blockedIssues as BlockedAttentionIssue[];
      const blockerAttentionOf = (issue: BlockedAttentionIssue) => countedBlockerAttention
        ? countedBlockerAttention.get(issue.id)
        : issue.blockerAttention;
      const terminalBlockerIssueIds = typedBlockedIssues
        .map((issue) => blockerAttentionOf(issue)?.terminalBlockerIssueId)
        .filter((issueId): issueId is string => Boolean(issueId));
      const [blockedIssueSummaries, terminalBlockerSummaries, blockerImageMap, blockingIssues] = await Promise.all([
        // Each blocked task as its card shows it, and as the task of the
        // card of its blocker. A count reads neither.
        countsOnly
          ? Promise.resolve(new Map<string, IssueSummaryRow>())
          : loadIssues(blockedIssues.map((issue) => issue.id)),
        loadIssues(terminalBlockerIssueIds),
        loadImages(
          db,
          companyId,
          [...blockedIssues.map((issue) => issue.id), ...terminalBlockerIssueIds],
          readCondition,
        ),
        // The blocker a card names and, below, the number of tasks a blocker
        // holds are card text.
        summaryOnly
          ? Promise.resolve(new Map<string, BlockingIssueSummary>())
          : blockingIssueMap(db, companyId, blockedIssues.map((issue) => issue.id), readCondition),
      ]);
      const terminalCandidates = new Map<string, {
        issue: BlockedAttentionIssue;
        issueSummary: IssueSummaryRow | null;
        terminalSummary: IssueSummaryRow | IssueSubjectRow;
        state: "stalled" | "needs_attention";
      }>();

      for (const issue of typedBlockedIssues) {
        const descriptor = issue.unblockDescriptor;
        const humanOwnerMatches = descriptor?.owner === "board"
          || (descriptor?.owner && "userId" in descriptor.owner && descriptor.owner.userId === options.userId);
        if (descriptor && humanOwnerMatches && isProspectiveBlockedTransition(issue)) {
          const issueSummary = blockedIssueSummaries.get(issue.id) ?? null;
          add(createItem({
            companyId,
            sourceKind: "blocker_attention",
            subject: issueSubject(prefix, issueSummary ?? issue),
            whyNow: descriptor.action,
            decisionVerbs: decisionVerbs(
              { id: "unblock", label: "Unblock", description: descriptor.action },
              { id: "reassign", label: "Reassign", description: "Route this blocked issue to another owner." },
            ),
            inlineResolvable: false,
            entryRule: "blocked issue has a human-owned unblockDescriptor",
            exitRule: "Issue leaves blocked status.",
            dedupKey: `blocked-owner:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
            severity: "high",
            activityAt: toIso(issue.blockedTransitionAt),
            createdAt: toIso(issue.createdAt),
            updatedAt: toIso(issue.updatedAt),
            relatedIssue: null,
            ...issueContext(issueSummary),
            detail: {
              kind: "blocker",
              blockingIssue: resolveBlockingIssue(issue, blockingIssues.get(issue.id)),
              images: issueImages(blockerImageMap, issue.id),
            },
          }), {
            issueId: issue.id,
            // A named user owner receives the card; a "board" owner falls through
            // to the issue chain (PAP-749 plan §1, "Other sources").
            ownerUserId: descriptor.owner && typeof descriptor.owner === "object" && "userId" in descriptor.owner
              ? descriptor.owner.userId
              : null,
          }, {
            content: { action: descriptor.action },
            since: issue.blockedTransitionAt,
          }, { key: `blocked:${issue.id}`, anchor: true });
        }
        const blockerAttention = blockerAttentionOf(issue);
        if (!terminalBlockerRequiresAttention(blockerAttention)) continue;
        const issueSummary = blockedIssueSummaries.get(issue.id) ?? null;
        const terminalIssueId = blockerAttention.terminalBlockerIssueId ?? issue.id;
        const terminalSummary = terminalBlockerSummaries.get(terminalIssueId)
          ?? (terminalIssueId === issue.id ? issueSummary ?? issue : null);
        if (!terminalSummary) continue;
        const current = terminalCandidates.get(terminalIssueId);
        if (!current || issue.updatedAt > current.issue.updatedAt) {
          terminalCandidates.set(terminalIssueId, {
            issue,
            issueSummary,
            terminalSummary,
            state: blockerAttention.state,
          });
        }
      }

      const blockedWorkCounts = summaryOnly
        ? new Map<string, number>()
        : await blockedWorkCountMap(db, companyId, [...terminalCandidates.keys()]);
      for (const [terminalIssueId, candidate] of terminalCandidates) {
        const blockedTaskCount = blockedWorkCounts.get(terminalIssueId) ?? 0;
        const taskLabel = blockedTaskCount === 1 ? "task" : "tasks";
        const dedupKey = `blocker:${terminalIssueId}`;
        add(createItem({
          companyId,
          sourceKind: "blocker_attention",
          subject: issueSubject(prefix, candidate.terminalSummary),
          whyNow: candidate.state === "needs_attention"
            ? `Blocks ${blockedTaskCount} ${taskLabel} and needs human attention.`
            : `Blocks ${blockedTaskCount} ${taskLabel}; choose the next owner or action.`,
          decisionVerbs: decisionVerbs(
            { id: "unblock", label: "Unblock", description: "Repair or replace the stalled blocker path." },
            { id: "reassign", label: "Reassign", description: "Assign the stalled blocker to a live owner." },
            { id: "nudge", label: "Nudge", description: "Wake or prompt the current owner." },
          ),
          inlineResolvable: false,
          entryRule: `terminal blocker has a non-live blockerAttention.state = '${candidate.state}'`,
          exitRule: "The blocking tree becomes live or no open work remains blocked.",
          dedupKey,
          severity: "high",
          activityAt: toIso(candidate.terminalSummary.updatedAt),
          createdAt: toIso(candidate.terminalSummary.createdAt),
          updatedAt: toIso(candidate.terminalSummary.updatedAt),
          relatedIssue: candidate.issueSummary ? issueSubject(prefix, candidate.issueSummary) : null,
          ...issueContext(candidate.terminalSummary),
          detail: {
            kind: "blocker",
            blockingIssue: null,
            blockedTaskCount,
            images: issueImages(blockerImageMap, terminalIssueId),
          },
        }), { issueId: terminalIssueId }, {
          content: { state: candidate.state },
          since: candidate.terminalSummary.updatedAt,
        }, { key: `blocked:${terminalIssueId}`, anchor: true });
      }

      const reviewRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          executionState: issues.executionState,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.status, "in_review"),
          executionIssueCondition(),
          readCondition,
          // A count does not read each review again as a card (below), so this
          // read applies the card's task condition itself.
          summaryOnly ? attentionIssueCondition() : undefined,
        ))
        .orderBy(desc(issues.updatedAt), desc(issues.id));
      const reviewIssueIds = reviewRows.map((row) => row.id);
      const pendingReviewApprovalRows = reviewIssueIds.length === 0
        ? []
        : await db
          .select({ issueId: issueApprovals.issueId, approvalId: approvals.id })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(issueApprovals.issueId, reviewIssueIds),
            eq(approvals.status, "pending"),
          ))
          .orderBy(asc(approvals.createdAt), asc(approvals.id));
      // The oldest pending approval per task, so the review joins the same
      // approval card on every read (Rule 11).
      const pendingApprovalByIssueId = new Map<string, string>();
      for (const row of pendingReviewApprovalRows) {
        if (!pendingApprovalByIssueId.has(row.issueId)) pendingApprovalByIssueId.set(row.issueId, row.approvalId);
      }
      const [reviewAttentionByIssueId, reviewIssueMap, reviewImageMap] = await Promise.all([
        issueService(db).listReviewAttention(companyId, reviewRows),
        summaryOnly
          ? Promise.resolve(new Map<string, IssueSummaryRow | IssueSubjectRow>(reviewRows.map((row) => [row.id, row])))
          : issueSummaryMap(db, companyId, reviewIssueIds, readCondition),
        loadImages(db, companyId, reviewIssueIds, readCondition),
      ]);

      for (const review of reviewRows) {
        const state = parseIssueExecutionState(review.executionState);
        const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId = pendingApprovalByIssueId.get(review.id) ?? null;
        const reviewAttention = reviewAttentionByIssueId.get(review.id);
        const stalled = reviewAttention?.state === "stalled";
        if (!requiresReviewAttention({ hasHumanParticipant, hasUserAssignee: Boolean(review.assigneeUserId),
          hasPendingApproval: Boolean(pendingApprovalId), stalled })) continue;
        const issue = reviewIssueMap.get(review.id);
        if (!issue) continue;
        const dedupKey = `review:${review.id}`;
        // A stalled review carries no interaction/approval/monitor to open, so
        // it is resolved in-row with the three review verbs (PAP-16080 §4.4).
        // Covered reviews still deep-link — their real action lives elsewhere
        // (the pending interaction/approval card, a monitor, a live run).
        const reviewSubject = issueSubject(prefix, issue);
        add(createItem({
          companyId,
          sourceKind: "review",
          subject: stalled
            ? { ...reviewSubject, metadata: { ...reviewSubject.metadata, reviewAttentionState: "stalled" } }
            : reviewSubject,
          whyNow: stalled
            ? "Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path."
            : pendingApprovalId
            ? "Issue is in review with a linked pending approval."
            : hasHumanParticipant
              ? "Issue is in review and the current execution participant is a user."
              : "Issue is in review and assigned to a user.",
          decisionVerbs: stalled
            ? decisionVerbs(
                { id: "choose_review_path", label: "Choose review path", description: "Add a reviewer or waiting path, return the issue to work, or accept it." },
                { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
              )
            : decisionVerbs(
                { id: "approve", label: "Approve", description: "Approve the review and advance the issue." },
                { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
              ),
          inlineResolvable: stalled,
          entryRule: stalled
            ? "issues.status = 'in_review' and reviewAttention.state = 'stalled'."
            : "issues.status = 'in_review' and human reviewer, user assignee, or linked pending approval exists.",
          exitRule: "Issue leaves in_review or the human review path resolves.",
          dedupKey,
          severity: stalled ? "high" : "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: null,
          ...issueContext(issue),
          detail: genericDetail(review.title, issueImages(reviewImageMap, review.id)),
        }), {
          issueId: review.id,
          reviewParticipantUserId: currentParticipant?.type === "user" ? currentParticipant.userId : null,
        }, {
          // A new review round (stage or decision) or a newly linked approval
          // is important; the reviewer is audience, not content.
          content: {
            stalled,
            pendingApprovalId,
            stageId: state?.currentStageId ?? null,
            lastDecisionId: state?.lastDecisionId ?? null,
          },
          since: review.updatedAt,
          // Rule 11: the in-review state of a task that waits on its approval is
          // the approval's obligation. A configured human review stage is an
          // independent quality gate and keeps its own card.
        }, pendingApprovalId && !hasHumanParticipant && !stalled
          ? { key: `approval:${pendingApprovalId}`, anchor: false }
          : null);
      }

      const failedRows = await listAttentionExhaustedRuns(db, companyId);
      const failedIssueIds = failedRows.map((row) => readRunIssueId(row.contextSnapshot));
      const [failedIssueMap, failedImageMap, failedRunsWithNewerRun] = await Promise.all([
        loadIssues(failedIssueIds),
        loadImages(db, companyId, failedIssueIds, readCondition),
        listFailedRunsWithNewerRun(db, companyId, failedRows.map((row, index) => ({
          id: row.id,
          agentId: row.agentId,
          issueId: failedIssueIds[index],
          createdAt: row.createdAt,
        }))),
      ]);
      for (const run of failedRows) {
        const issueId = readRunIssueId(run.contextSnapshot);
        if (failedRunsWithNewerRun.has(run.id)) continue;

        const issue = issueId ? failedIssueMap.get(issueId) ?? null : null;
        if (issueId && !issue) continue;
        const dedupKey = `run:${run.id}`;
        add(createItem({
          companyId,
          sourceKind: "failed_run",
          subject: {
            kind: "run",
            id: run.id,
            companyId,
            title: `${run.agentName} run ${run.status}`,
            identifier: null,
            status: run.status,
            href: `/${prefix}/agents/${run.agentId}/runs/${run.id}`,
            metadata: {
              agentId: run.agentId,
              agentName: run.agentName,
              issueId,
              errorCode: run.errorCode,
              error: run.error ? withoutSqlStatementText(run.error) : run.error,
              retryExhaustedReason: run.exhaustionMessage,
            },
          },
          whyNow: "Run failed after automatic retries were exhausted.",
          // PAP-749 Rule 7: offer only what works. Retry uses the task retry
          // (POST /issues/:id/retry); reassigning happens on the task; hiding
          // the card is "Archive for me" in the Close… menu.
          decisionVerbs: issueId
            ? decisionVerbs(
                { id: "retry", label: "Retry", description: "Retry the task's failed run." },
                { id: "inspect", label: "Open run", description: "Open the run log to see why it failed." },
              )
            : decisionVerbs(
                { id: "inspect", label: "Open run", description: "Open the run log to see why it failed." },
              ),
          inlineResolvable: Boolean(issueId),
          entryRule: "latest failed/timed_out run has a Bounded retry exhausted lifecycle event.",
          exitRule: "A newer run exists for the same issue/agent pair or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(run.finishedAt ?? run.updatedAt ?? run.createdAt),
          createdAt: toIso(run.createdAt),
          updatedAt: toIso(run.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          ...issueContext(issue),
          detail: {
            kind: "failed_run",
            agentName: run.agentName,
            // Rows saved before SQL text was kept out of run errors still carry it.
            failureReasonExcerpt: excerpt((run.error ? withoutSqlStatementText(run.error) : null) ?? run.exhaustionMessage ?? run.errorCode),
            images: issueImages(failedImageMap, issueId),
          },
        }), { issueId, companyScoped: true }, {
          // Each failed run is its own card; nothing about it changes later.
          content: null,
          since: run.finishedAt ?? run.updatedAt ?? run.createdAt,
          // Rule 11: a failed run joins the card for the task it blocks, if any.
        }, issueId ? { key: `blocked:${issueId}`, anchor: false } : null);
      }

      // A count reads the open incidents of the budget overview without the
      // spend of every policy, which the overview also sums.
      const openBudgetIncidents = summaryOnly
        ? await budgetService(db).openIncidents(companyId)
        : (await budgetService(db).overview(companyId)).activeIncidents;
      for (const incident of openBudgetIncidents) {
        const observedPercent = budgetObservedPercent(incident.amountObserved, incident.amountLimit);
        if (incident.thresholdType !== "hard" && observedPercent < ATTENTION_BUDGET_WARNING_PERCENT) continue;
        const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
        add(createItem({
          companyId,
          sourceKind: "budget_alert",
          subject: {
            kind: "budget_incident",
            id: incident.id,
            companyId,
            title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
            identifier: null,
            status: incident.status,
            href: `/${prefix}/costs`,
            metadata: {
              policyId: incident.policyId,
              scopeType: incident.scopeType,
              scopeId: incident.scopeId,
              thresholdType: incident.thresholdType,
              amountObserved: incident.amountObserved,
              amountLimit: incident.amountLimit,
              observedPercent,
              approvalId: incident.approvalId,
              approvalStatus: incident.approvalStatus,
            },
          },
          whyNow: incident.thresholdType === "hard"
            ? "Budget hard stop was reached."
            : "Budget crossed the 85% warning threshold.",
          decisionVerbs: decisionVerbs(
            { id: "raise_budget_and_resume", label: "Raise limit", description: "Raise the budget limit and resume paused work." },
            { id: "keep_paused", label: "Keep paused", description: "Dismiss or keep the budget stop in place." },
          ),
          inlineResolvable: true,
          entryRule: "open budget incident is hard, or soft with observed spend >= 85% of limit.",
          exitRule: "Budget incident is resolved or dismissed.",
          dedupKey,
          severity: incident.thresholdType === "hard" ? "high" : "medium",
          activityAt: toIso(incident.updatedAt),
          createdAt: toIso(incident.createdAt),
          updatedAt: toIso(incident.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "budget",
            observedPercent,
            amountObserved: incident.amountObserved,
            amountLimit: incident.amountLimit,
            images: [],
          },
        }), {
          issueId: null,
          companyScoped: true,
          // A hard stop pauses work, so the budget owner also gets it (task 1d).
          escalatesToBudgetOwner: incident.thresholdType === "hard",
        }, {
          // Spend creeping upward inside one incident is not a new choice.
          content: { status: incident.status },
          since: incident.createdAt,
          // Rule 11 (PAP-768): the hard stop and its override approval are one
          // card. The stop leads; the approval, which has no owner of its own,
          // is its evidence and leaves Unassigned.
        }, incident.thresholdType === "hard" && incident.approvalId
          ? { key: `approval:${incident.approvalId}`, anchor: true }
          : null);
      }

      const erroredAgents = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          errorReason: agents.errorReason,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.status, ATTENTION_AGENT_ERROR_STATUS)))
        .orderBy(desc(agents.updatedAt), desc(agents.id));

      for (const agent of erroredAgents) {
        const dedupKey = `agent_error:${agent.id}`;
        add(createItem({
          companyId,
          sourceKind: "agent_error_alert",
          subject: {
            kind: "agent",
            id: agent.id,
            companyId,
            title: agent.name,
            identifier: null,
            status: agent.status,
            href: `/${prefix}/agents/${agent.id}`,
            metadata: { role: agent.role, errorReason: agent.errorReason },
          },
          whyNow: "Agent is in error status and needs operator action or dismissal.",
          // PAP-749 Rule 7: the fix happens on the agent page; hiding the alert
          // is "Archive for me" in the Close… menu.
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the agent error." },
          ),
          inlineResolvable: false,
          entryRule: "agents.status = 'error'",
          exitRule: "Agent leaves error status or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(agent.updatedAt),
          createdAt: toIso(agent.createdAt),
          updatedAt: toIso(agent.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "agent_error",
            agentName: agent.name,
            failureReasonExcerpt: excerpt(agent.errorReason),
            images: [],
          },
        }), { issueId: null, companyScoped: true }, {
          content: { errorReason: agent.errorReason },
          since: agent.updatedAt,
        });
      }

      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      // Resolve each surviving item's audience exactly once (PAP-749 plan §1,
      // Rule 2). The instigator step walks the parent chain, so batch the
      // per-issue context lookup across every item rather than per source.
      const dedupedItems = [...deduped.values()];
      const audienceContext = await resolveIssueAudienceContextMap(
        db,
        companyId,
        dedupedItems.map((item) => audienceInputByDedupKey.get(item.dedupKey)?.issueId ?? null),
      );
      const audienceConfig: AttentionAudienceCompanyConfig = {
        defaultDecisionOwnerUserId: companyConfig.defaultDecisionOwnerUserId,
        budgetOwnerUserId: companyConfig.budgetOwnerUserId,
      };
      const currentItems: AttentionItem[] = [];
      for (const item of dedupedItems) {
        const input = audienceInputByDedupKey.get(item.dedupKey) ?? { issueId: null };
        const ctx = input.issueId ? audienceContext.get(input.issueId) ?? null : null;
        const change = changeBasisByDedupKey.get(item.dedupKey) ?? { content: null, since: item.createdAt };
        const audience = resolveAttentionAudience(input, ctx, audienceConfig);
        // Rule 10: label stale cards and move old ones to a person or Company.
        // Nothing here withdraws a card or treats it as answered.
        item.stale = resolveAttentionStale({
          sourceKind: item.sourceKind,
          issueStatus: ctx?.issueStatus,
          since: change.since,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          audience,
          now,
        });
        item.required = change.required === true;
        item.audience = escalateStaleAudience({
          audience,
          since: change.since,
          required: item.required,
          now,
          companyConfig: audienceConfig,
          ctx,
        });
        // Explicit recipients stay private to their addressee until required
        // work escalates. Apply this after routing so the escalation owner or
        // Company can collect the request while task read access still applies.
        if (input.addresseeUserId && input.addresseeUserId !== options.userId
          && item.audience.kind === "user" && item.audience.userId !== options.userId) continue;
        currentItems.push(item);
      }
      // Rule 11: one card for each obligation. Members share one placement, so
      // the fingerprint below reads the obligation's audience.
      assignAttentionObligations(currentItems, obligationHintByDedupKey);
      for (const item of currentItems) {
        // A count reads a fingerprint only to compare it with a dismissal.
        if (summaryOnly && !dismissals.has(item.dismissalKey)) continue;
        const change = changeBasisByDedupKey.get(item.dedupKey) ?? { content: null, since: item.createdAt };
        item.changeFingerprint = attentionChangeFingerprint({
          sourceKind: item.sourceKind,
          content: change.content,
          forViewer: item.audience.kind === "user" && item.audience.userId != null
            && item.audience.userId === options.userId,
        });
        // Rule 9: a personally hidden card returns only on a fingerprint change.
        // Hidden cards stay in the snapshot so the Archived view and its tab
        // count can read them; the view filter below drops them elsewhere.
        item.dismissal = activeDismissalState(dismissals, item, now);
      }

      // "Transferred by @x" on a card that reached its person through a
      // transfer (PAP-749 plan §6, Rule 12).
      if (!summaryOnly) await attachTransferredBy(db, companyId, currentItems);

      const collectedItems = currentItems.sort(compareAttentionItems);
      await decisionQueueService(db).materializeSeededQueues(companyId, collectedItems);
      // Queue membership filters a feed by queue and labels its cards. A
      // count without a queue filter does not read it.
      const enrichedItems = await enrichAttentionItems(db, companyId, collectedItems, now, !summaryOnly,
        !summaryOnly || Boolean(options.queue?.trim()));

      const activitySince = parseActivityBoundary(options.activitySince, "activitySince");
      const activityUntil = parseActivityBoundary(options.activityUntil, "activityUntil");
      if (activitySince != null && activityUntil != null && activitySince > activityUntil) {
        throw badRequest("activitySince must be before or equal to activityUntil");
      }
      const queueKey = options.queue?.trim() || null;
      const hiddenForViewer = (item: AttentionItem) => item.dismissal?.isActive === true;
      // Rule 11: evidence shows and hides with its lead, so archiving, snoozing
      // or filtering the one card never leaves part of the obligation behind.
      const enrichedById = new Map(enrichedItems.map((item) => [item.id, item]));
      const obligationLeadOf = (item: AttentionItem) =>
        isObligationEvidence(item) ? enrichedById.get(item.obligationLeadId!) ?? item : item;
      const visibleItems = enrichedItems.filter((member) => {
        const item = obligationLeadOf(member);
        if (view === "archived") {
          // The person's own Archived view (PAP-749 plan §3): open cards they
          // archived or snoozed, and nothing else.
          if (!hiddenForViewer(item)) return false;
        } else {
          // `all` (the default) keeps the pre-PAP-749 superset; the other views
          // partition by resolved audience (PAP-749 plan §1, Rule 3).
          if (view !== "all" && !audienceMatchesView(item.audience, view, options.userId)) return false;
          if (!includeDismissed && hiddenForViewer(item)) return false;
        }
        if (options.archived === true ? !item.archivedAt : Boolean(item.archivedAt)) return false;
        if (!includeDismissed && item.snoozedUntil && timestamp(item.snoozedUntil) > now) return false;
        const activity = timestamp(item.activityAt);
        if (activitySince != null && activity < activitySince) return false;
        if (activityUntil != null && activity > activityUntil) return false;
        if (queueKey && !item.queues.some((queue) => queue.key === queueKey)) return false;
        return true;
      });

      const countsBySourceKind = emptyCounts();
      for (const item of visibleItems) countsBySourceKind[item.sourceKind] += 1;
      // One count per view for the switch, the Unassigned banner and the shared
      // badge (PAP-749 plan §1, Rule 5). Counted before the view, date and queue
      // filters and pagination, so every surface reads the same numbers. The
      // three audience views and Everyone skip the cards this person archived
      // or snoozed; the Archived tab counts exactly those (plan §3). Only For
      // you is the badge. Each obligation counts once, as its lead (Rule 11).
      const viewCounts: AttentionViewCounts = { mine: 0, unassigned: 0, company: 0, archived: 0, all: 0 };
      for (const item of enrichedItems) {
        if (obligationLeadOf(item) !== item) continue;
        if (item.archivedAt) continue;
        if (item.snoozedUntil && timestamp(item.snoozedUntil) > now) continue;
        if (hiddenForViewer(item)) {
          viewCounts.archived += 1;
          continue;
        }
        for (const countedView of ATTENTION_PERSONAL_VIEWS) {
          if (countedView === "archived") continue;
          if (audienceMatchesView(item.audience, countedView, options.userId)) viewCounts[countedView] += 1;
        }
      }

      const summary: AttentionSummary = { companyId, generatedAt: new Date().toISOString(), totalCount: visibleItems.length, deskBadgeCount: viewCounts.mine, viewCounts, countsBySourceKind };
      if (summaryOnly) return { ...summary, nextCursor: null, items: visibleItems };

      const sort = options.sort ?? "activity";
      if (sort !== "activity" && sort !== "decide") throw badRequest("sort must be 'activity' or 'decide'");
      const selectedComparator = sort === "decide"
        ? (left: AttentionItem, right: AttentionItem) => compareDecideItems(left, right, now)
        : compareAttentionItems;
      const rankedItems = keepObligationsTogether(orderBlockedAttentionByWeight(
        visibleItems.sort(selectedComparator),
        selectedComparator,
      ))
        .map((item, index) => ({ ...item, rank: index + 1 }));
      let items: AttentionItem[];
      let nextCursor: string | null;
      if (options.all) {
        if (options.cursor || options.limit !== undefined) {
          throw badRequest("all cannot be combined with cursor or limit");
        }
        items = rankedItems;
        nextCursor = null;
      } else {
        const limit = options.limit ?? ATTENTION_PAGE_DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > ATTENTION_PAGE_MAX_LIMIT) {
          throw badRequest(`limit must be an integer between 1 and ${ATTENTION_PAGE_MAX_LIMIT}`);
        }
        let pageStart = 0;
        if (options.cursor) {
          const cursorItemId = decodeCursor(options.cursor, sort);
          const cursorIndex = rankedItems.findIndex((item) => item.id === cursorItemId);
          if (cursorIndex < 0) throw badRequest("Attention cursor no longer matches the filtered feed");
          pageStart = cursorIndex + 1;
        }
        items = rankedItems.slice(pageStart, pageStart + limit);
        const hasNextPage = pageStart + items.length < rankedItems.length;
        nextCursor = hasNextPage && items.length > 0 ? encodeCursor(sort, items[items.length - 1]!) : null;
      }

      if (options.userId) {
        const trainable: Array<{ sourceKind: "approval" | "interaction"; sourceId: string }> = [];
        for (const item of items) {
          if (item.sourceKind === "approval") {
            trainable.push({ sourceKind: "approval", sourceId: item.subject.id });
          }
          if (item.sourceKind === "issue_thread_interaction") {
            trainable.push({ sourceKind: "interaction", sourceId: item.subject.id });
          }
        }
        if (trainable.length > 0) {
          const examples = await db
            .select({
              id: decisionTrainingExamples.id,
              sourceKind: decisionTrainingExamples.sourceKind,
              sourceId: decisionTrainingExamples.sourceId,
            })
            .from(decisionTrainingExamples)
            .where(and(
              eq(decisionTrainingExamples.companyId, companyId),
              eq(decisionTrainingExamples.createdByUserId, options.userId),
              inArray(decisionTrainingExamples.sourceId, trainable.map((item) => item.sourceId)),
            ));
          const exampleBySource = new Map(examples.map((row) => [`${row.sourceKind}:${row.sourceId}`, row.id]));
          for (const item of items) {
            const sourceKind = item.sourceKind === "approval"
              ? "approval"
              : item.sourceKind === "issue_thread_interaction"
                ? "interaction"
                : null;
            item.trainingExampleId = sourceKind
              ? exampleBySource.get(`${sourceKind}:${item.subject.id}`) ?? null
              : null;
          }
        }
      }
      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: rankedItems.length,
        // The badge is the "For you" count. It has no day boundary: an open
        // card stays in it until a person answers it.
        deskBadgeCount: viewCounts.mine,
        viewCounts,
        nextCursor,
        countsBySourceKind,
        items,
      };

  }
  return {
    list: (companyId: string, options: AttentionListOptions = {}) => list(companyId, options),
    taskQuestions: async (companyId: string, issueIds: readonly string[], options: { actor: AuthorizationActor; userId: string }): Promise<AttentionItem[]> => {
      if (issueIds.length === 0) return [];
      const feed = await list(companyId, { ...options, all: true, allowUnscopedAll: true }, issueIds);
      return feed.items;
    },
    summary: async (companyId: string, options: Pick<AttentionListOptions, "userId" | "actor"> = {}): Promise<AttentionSummary> => {
      const { items: _items, nextCursor: _cursor, ...summary } = await list(companyId, {
        ...options, all: true, allowUnscopedAll: true, countsOnly: true,
      });
      return summary;
    },
    taskIndex: async (companyId: string, options: Pick<AttentionListOptions, "userId" | "actor"> = {}): Promise<AttentionTaskIndex> => {
      const { items, nextCursor: _cursor, ...summary } = await list(companyId, {
        ...options, all: true, allowUnscopedAll: true, summaryOnly: true,
      });
      return { ...summary, taskIds: [...new Set(items.flatMap(item => item.relatedIssue
        ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []))] };
    },

    /**
     * Claim an ownerless card (PAP-749 plan §1, Rule 3). The claimer becomes the
     * addressee, so the card leaves the Unassigned pool of every other person
     * and moves to the claimer's "For you". This changes placement only: the
     * resolver policy still decides who may answer. Only sources with an
     * addressee field can store a claim; the caller writes the activity entry.
     */
    claim: async (
      companyId: string,
      input: { sourceKind: string; sourceId: string; userId: string; actor: AuthorizationActor },
    ): Promise<AttentionClaimResult & { issueId: string; previousAddresseeAgentId: string | null }> => {
      if (!(ATTENTION_CLAIMABLE_SOURCE_KINDS as readonly string[]).includes(input.sourceKind)) {
        throw unprocessable("This card has no addressee to claim. Open it to act on it.");
      }
      if (input.userId !== input.actor.userId) throw forbidden("A claim must name the signed-in user.");
      return db.transaction(async tx => {
        const db = tx as unknown as Db;
        const { issue, interaction } = await lockAttentionRoutingSource(db, companyId, input.sourceId, input.actor);
        const row = { ...interaction, issueStatus: issue.status, executionPolicy: issue.executionPolicy,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
          conversationAgentId: issue.conversationAgentId, conversationUserId: issue.conversationUserId };
        const result = {
          sourceKind: "issue_thread_interaction" as const,
          sourceId: row.id,
          issueId: row.issueId,
          claimedByUserId: input.userId,
        };
        if (!(PENDING_INTERACTION_STATUSES as readonly string[]).includes(row.status)) {
          throw attentionAlreadyClosedError({ sourceKind: "issue_thread_interaction", sourceId: row.id, ...row });
        }
        if (row.addresseeUserId === input.userId) {
          return { ...result, alreadyClaimed: true, previousAddresseeAgentId: null };
        }
        if (row.addresseeUserId) {
          throw conflict("This card is already for another person", { addresseeUserId: row.addresseeUserId });
        }
        const contexts = await resolveIssueAudienceContextMap(db, companyId, [row.issueId]);
        const config = await loadCompanyAttentionConfig(db, companyId);
        const audience = resolveAttentionAudience({ issueId: row.issueId, addresseeUserId: row.addresseeUserId }, contexts.get(row.issueId) ?? null, config);
        if (audience.kind === "user") {
          throw conflict("This card already has an owner", { addresseeUserId: audience.userId });
        }
        if (row.addresseeAgentId) {
          // A request to an agent that can still run stays with that agent; only
          // a stuck agent's request reaches the pool (plan §1, special conditions).
          const companyAgentRows: AgentOrgRow[] = await db
            .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status })
            .from(agents)
            .where(eq(agents.companyId, companyId));
          const addressee = companyAgentRows.find((agent) => agent.id === row.addresseeAgentId);
          if (evaluateAgentInvokability(addressee, companyAgentRows).invokable) {
            throw conflict("This request is for an agent that can still answer it");
          }
        }
        await assertInteractionRoutingRecipientAllowed(db, issue, interaction, input.userId);
        // An interaction names an agent or a user, never both, so the claim
        // replaces a stuck agent addressee. The status and empty-addressee guard
        // make two simultaneous claims resolve to one winner.
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({ addresseeUserId: input.userId, addresseeAgentId: null, updatedAt: new Date() })
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.id, row.id),
            inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
            isNull(issueThreadInteractions.addresseeUserId),
          ))
          .returning({ id: issueThreadInteractions.id });
        if (!updated) {
          const closed = await attentionService(db, serviceOptions).alreadyClosedError(companyId, {
            sourceKind: "issue_thread_interaction", sourceId: row.id, actor: input.actor,
          });
          throw closed ?? conflict("Someone else claimed this card first");
        }
        return { ...result, alreadyClaimed: false, previousAddresseeAgentId: row.addresseeAgentId };
      });
    },

    /**
     * Archive or snooze a card for one person (PAP-749 plan §2, Rule 6). The
     * source stays open and teammates still see the card. The card is looked up
     * in this person's own feed, so the dismissal key and change fingerprint
     * are the ones the list compares; a card the person cannot see is 404.
     */
    hideForUser: async (
      companyId: string,
      input: {
        sourceKind: AttentionSourceKind;
        sourceId: string;
        userId: string;
        actor: AuthorizationActor;
        mode: "archive" | "snooze";
        until?: string | null;
        fingerprint?: string | null;
      },
    ) => {
      const feed = await attentionService(db, serviceOptions).list(companyId, {
        userId: input.userId,
        actor: input.actor,
        view: "all",
        all: true,
        allowUnscopedAll: true,
        includeDismissed: true,
      });
      const requested = feed.items.find((entry) => entry.sourceKind === input.sourceKind && entry.subject.id === input.sourceId);
      const item = requested?.obligationLeadId && requested.obligationLeadId !== requested.id
        ? feed.items.find(entry => entry.id === requested.obligationLeadId) ?? requested
        : requested;
      if (!item) {
        const state = await sourceCloseState(db, companyId, input.sourceKind, input.sourceId, input.actor);
        if (state && !state.open) throw attentionAlreadyClosedError({ sourceKind: input.sourceKind, sourceId: input.sourceId, ...state });
        throw notFound("Card not found");
      }
      if (!item.closeModes.includes(input.mode)) {
        throw unprocessable("This card cannot be hidden.", { code: "attention_close_mode_unsupported", closeModes: item.closeModes });
      }
      // The version the person saw; the card returns when its content differs.
      const fingerprint = item.id === requested?.id ? input.fingerprint ?? item.changeFingerprint : item.changeFingerprint;
      const dismissals = inboxDismissalService(db);
      const dismissal = input.mode === "snooze"
        ? await dismissals.snooze(companyId, input.userId, item.dismissalKey, new Date(input.until!), new Date(), fingerprint)
        : await dismissals.dismiss(companyId, input.userId, item.dismissalKey, new Date(), fingerprint);
      return {
        issueId: attentionItemIssueId(item),
        itemKey: dismissal.itemKey,
        fingerprint: dismissal.fingerprint,
        until: dismissal.snoozedUntil ? dismissal.snoozedUntil.toISOString() : null,
      };
    },

    /**
     * Find and check the source that "Withdraw request" closes (PAP-749 plan §2,
     * Rule 6): an interaction (withdraw), a decision (cancel) or an approval
     * (cancel). The caller runs the owner's withdraw flow, which tells the
     * agent. 422 for cards with no request to withdraw, 404 when the person
     * cannot read the source, 409 when someone already answered it.
     */
    withdrawTarget: async (
      companyId: string,
      input: { sourceKind: AttentionSourceKind; sourceId: string; actor: AuthorizationActor },
    ): Promise<
      | { sourceKind: "issue_thread_interaction"; issueId: string; issue: { id: string; companyId: string; status: string; assigneeAgentId: string | null } }
      | { sourceKind: "approval"; issueId: string | null }
      | { sourceKind: "decision"; issueId: string }
    > => {
      if (!WITHDRAWABLE_SOURCE_KINDS.has(input.sourceKind)) {
        throw unprocessable(WITHDRAW_UNSUPPORTED_TEXT[input.sourceKind] ?? "This card has no request to withdraw.", {
          code: "attention_close_mode_unsupported",
          closeModes: attentionCloseModes(input.sourceKind, { metadata: undefined }),
        });
      }
      const state = await sourceCloseState(db, companyId, input.sourceKind, input.sourceId, input.actor);
      if (!state) throw notFound("Card not found");
      if (input.sourceKind === "approval" && state.approvalType === "hire_agent") {
        throw unprocessable("Reject this hire request instead of withdrawing it.", {
          code: "attention_close_mode_unsupported",
          closeModes: attentionCloseModes("approval", { metadata: { type: "hire_agent" } }),
        });
      }
      if (!state.open) throw attentionAlreadyClosedError({ sourceKind: input.sourceKind, sourceId: input.sourceId, ...state });
      if (input.sourceKind === "issue_thread_interaction") {
        return { sourceKind: "issue_thread_interaction", issueId: state.issue!.id, issue: state.issue! };
      }
      if (input.sourceKind === "decision") return { sourceKind: "decision", issueId: state.issueId! };
      return { sourceKind: "approval", issueId: state.issueId };
    },

    /** The 409 for a source someone else closed first, or `null` while it is open. */
    alreadyClosedError: async (
      companyId: string,
      input: { sourceKind: AttentionSourceKind; sourceId: string; actor: AuthorizationActor },
    ) => {
      const state = await sourceCloseState(db, companyId, input.sourceKind, input.sourceId, input.actor);
      return state && !state.open
        ? attentionAlreadyClosedError({ sourceKind: input.sourceKind, sourceId: input.sourceId, ...state })
        : null;
    },

    /**
     * Transfer a card to a different person, "Route to @x" (PAP-749 plan §2,
     * Rule 6). Like Claim, it stores the person as the addressee, so the card
     * moves to their "For you" and only they may answer it. Only its current
     * addressee or a routing administrator may change an addressed request;
     * the new owner must satisfy its own resolver and review rules. The caller
     * writes the activity entry.
     */
    transfer: async (
      companyId: string,
      input: { sourceKind: string; sourceId: string; toUserId: string; actor: AuthorizationActor },
    ): Promise<AttentionTransferResult & { issueId: string; previousAddresseeAgentId: string | null }> => {
      if (!(ATTENTION_CLAIMABLE_SOURCE_KINDS as readonly string[]).includes(input.sourceKind)) {
        throw unprocessable("This card has no addressee to transfer. Open it to act on it.");
      }
      return db.transaction(async tx => {
        const db = tx as unknown as Db;
        const { issue, interaction, observed } = await lockAttentionRoutingSource(db, companyId, input.sourceId, input.actor);
        const row = { ...interaction, issueStatus: issue.status, executionPolicy: issue.executionPolicy,
          assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
          conversationAgentId: issue.conversationAgentId, conversationUserId: issue.conversationUserId };
        const result = {
          sourceKind: "issue_thread_interaction" as const,
          sourceId: row.id,
          issueId: row.issueId,
          transferredToUserId: input.toUserId,
          previousAddresseeUserId: row.addresseeUserId,
        };
        if (!(PENDING_INTERACTION_STATUSES as readonly string[]).includes(row.status)) {
          throw attentionAlreadyClosedError({ sourceKind: "issue_thread_interaction", sourceId: row.id, ...row });
        }
        if (row.addresseeUserId === input.toUserId) {
          return { ...result, alreadyTransferred: true, previousAddresseeAgentId: null };
        }
        if (row.addresseeUserId !== observed.addresseeUserId || row.addresseeAgentId !== observed.addresseeAgentId) {
          throw conflict("Someone else routed this card first");
        }
        if (row.addresseeUserId && row.addresseeUserId !== input.actor.userId) {
          const admin = await authorizationService(db).decide({ actor: input.actor, action: "attention:route", resource: { type: "company", companyId } });
          if (!admin.allowed) throw forbidden("Only the addressed user or a routing administrator can transfer this request.");
        }
        if (row.kind === "ask_user_questions" && row.conversationAgentId && row.conversationUserId) {
          // Chat ownership is server-owned: a chat question stays with its owner.
          throw unprocessable("A chat question stays with the person in the chat.", {
            code: "interaction_chat_addressee_mismatch",
          });
        }
        if (row.addresseeAgentId) {
          // A request to an agent that can still run stays with that agent.
          const companyAgentRows: AgentOrgRow[] = await db
            .select({ id: agents.id, companyId: agents.companyId, name: agents.name, reportsTo: agents.reportsTo, status: agents.status })
            .from(agents)
            .where(eq(agents.companyId, companyId));
          const addressee = companyAgentRows.find((agent) => agent.id === row.addresseeAgentId);
          if (evaluateAgentInvokability(addressee, companyAgentRows).invokable) {
            throw conflict("This request is for an agent that can still answer it");
          }
        }
        const recipientRead = await issueReadSqlCondition(db, { type: "board", userId: input.toUserId });
        const [readableTask] = await db.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, companyId), eq(issues.id, row.issueId), recipientRead,
        )).limit(1);
        if (!readableTask) throw unprocessable("This person cannot access the task.");
        await assertInteractionRoutingRecipientAllowed(db, issue, interaction, input.toUserId);
        // Compare-and-set on the addressee seen above, so two people routing the
        // same card at once resolve to one winner instead of a silent overwrite.
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({ addresseeUserId: input.toUserId, addresseeAgentId: null, updatedAt: new Date() })
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            eq(issueThreadInteractions.id, row.id),
            inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
            row.addresseeUserId === null
              ? isNull(issueThreadInteractions.addresseeUserId)
              : eq(issueThreadInteractions.addresseeUserId, row.addresseeUserId),
          ))
          .returning({ id: issueThreadInteractions.id });
        if (!updated) {
          const closed = await attentionService(db, serviceOptions).alreadyClosedError(companyId, {
            sourceKind: "issue_thread_interaction", sourceId: row.id, actor: input.actor,
          });
          throw closed ?? conflict("Someone else routed this card first");
        }
        return { ...result, alreadyTransferred: false, previousAddresseeAgentId: row.addresseeAgentId };
      });
    },
  };
}

const WITHDRAWABLE_SOURCE_KINDS: ReadonlySet<AttentionSourceKind> = new Set<AttentionSourceKind>([
  "issue_thread_interaction",
  "decision",
  "approval",
]);

/** Where to go instead, for cards with no request to withdraw (PAP-749 Rules 6-7). */
const WITHDRAW_UNSUPPORTED_TEXT: Partial<Record<AttentionSourceKind, string>> = {
  budget_alert: "Budget cards are not withdrawn. Raise the limit or keep it paused, or archive the card for yourself.",
  recovery_action: "Cancel this recovery on its task, where you also choose the task's next status.",
  failed_run: "A failed run is not a request. Retry the task, or archive the card for yourself.",
  agent_error_alert: "Fix the agent on its page, or archive the alert for yourself.",
  review: "Approve the review or request changes, or archive the card for yourself.",
  blocker_attention: "Unblock the task on its page, or archive the card for yourself.",
  join_request: "Approve or reject the join request, or archive the card for yourself.",
};

/**
 * Mark cards whose addressee came from "Route to @x" with the person who
 * routed them. Reads the newest `attention.transferred` entry per card; a
 * later claim or re-address that does not match it leaves the card unmarked.
 */
async function attachTransferredBy(db: Db, companyId: string, items: AttentionItem[]) {
  const addressed = items.filter((item) => item.sourceKind === "issue_thread_interaction"
    && item.audience.kind === "user" && item.audience.reason === "addressee" && item.audience.userId);
  if (addressed.length === 0) return;
  const issueIds = [...new Set(addressed.map(attentionItemIssueId).filter((id): id is string => Boolean(id)))];
  const latest = new Map<string, { toUserId: string | null; byUserId: string | null; at: number }>();
  for (const chunk of chunkValues(issueIds, ATTENTION_GRAPH_QUERY_CHUNK_SIZE)) {
    const rows = await db
      .select({ actorId: activityLog.actorId, createdAt: activityLog.createdAt, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, chunk),
        eq(activityLog.action, "attention.transferred"),
      ));
    for (const row of rows) {
      const details = readRecord(row.details);
      const sourceId = readString(details.sourceId);
      const at = timestamp(row.createdAt);
      if (!sourceId || (latest.get(sourceId)?.at ?? -1) >= at) continue;
      latest.set(sourceId, {
        toUserId: readString(details.transferredToUserId),
        byUserId: readString(details.transferredByUserId) ?? row.actorId,
        at,
      });
    }
  }
  for (const item of addressed) {
    const transfer = latest.get(item.subject.id);
    if (!transfer?.byUserId || transfer.toUserId !== item.audience.userId || transfer.byUserId === transfer.toUserId) continue;
    item.audience = { ...item.audience, transferredByUserId: transfer.byUserId };
  }
}

function attentionItemIssueId(item: AttentionItem): string | null {
  if (item.relatedIssue) return item.relatedIssue.id;
  if (item.subject.kind === "issue") return item.subject.id;
  const metadataIssueId = item.subject.metadata?.issueId ?? item.subject.metadata?.sourceIssueId;
  return typeof metadataIssueId === "string" ? metadataIssueId : null;
}

type SourceCloseState = {
  open: boolean;
  status: string;
  resolvedByUserId: string | null;
  resolvedByAgentId: string | null;
  resolvedAt: Date | null;
  issueId: string | null;
  issue?: { id: string; companyId: string; status: string; assigneeAgentId: string | null };
  approvalType?: string;
};

/**
 * Open/closed state of a withdrawable source, read under the person's read
 * rules: `null` when it does not exist or they cannot read it. Used for the
 * 409 "Already answered by @x" (PAP-749 plan §2, special conditions).
 */
async function sourceCloseState(
  db: Db,
  companyId: string,
  sourceKind: AttentionSourceKind,
  sourceId: string,
  actor: AuthorizationActor,
): Promise<SourceCloseState | null> {
  if (sourceKind === "issue_thread_interaction") {
    const readCondition = await issueReadSqlCondition(db, actor);
    const [row] = await db
      .select({
        status: issueThreadInteractions.status,
        resolvedByUserId: issueThreadInteractions.resolvedByUserId,
        resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
        resolvedAt: issueThreadInteractions.resolvedAt,
        issueId: issues.id,
        issueStatus: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issues.id, issueThreadInteractions.issueId))
      .where(and(
        eq(issueThreadInteractions.companyId, companyId),
        eq(issueThreadInteractions.id, sourceId),
        eq(issues.companyId, companyId),
        readCondition,
      ))
      .limit(1);
    if (!row) return null;
    return {
      open: (PENDING_INTERACTION_STATUSES as readonly string[]).includes(row.status),
      status: row.status,
      resolvedByUserId: row.resolvedByUserId,
      resolvedByAgentId: row.resolvedByAgentId,
      resolvedAt: row.resolvedAt,
      issueId: row.issueId,
      issue: { id: row.issueId, companyId, status: row.issueStatus, assigneeAgentId: row.assigneeAgentId },
    };
  }
  if (sourceKind === "approval") {
    const [row] = await db
      .select({
        id: approvals.id,
        type: approvals.type,
        status: approvals.status,
        decidedByUserId: approvals.decidedByUserId,
        decidedAt: approvals.decidedAt,
        issueId: firstApprovalIssueId(),
      })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.id, sourceId)))
      .limit(1);
    if (!row || !(await canActorReadApproval(db, actor, row.id))) return null;
    return {
      open: (resolvableApprovalStatuses as readonly string[]).includes(row.status),
      status: row.status,
      resolvedByUserId: row.decidedByUserId,
      resolvedByAgentId: null,
      resolvedAt: row.decidedAt,
      issueId: row.issueId ?? null,
      approvalType: row.type,
    };
  }
  if (sourceKind === "decision") {
    const readCondition = await issueReadSqlCondition(db, actor);
    const [row] = await db
      .select({
        status: decisions.status,
        decidedByUserId: decisions.decidedByUserId,
        decidedAt: decisions.decidedAt,
        updatedAt: decisions.updatedAt,
        issueId: issues.id,
      })
      .from(decisions)
      .innerJoin(issues, and(eq(issues.id, decisions.originIssueId), eq(issues.companyId, companyId)))
      .where(and(eq(decisions.companyId, companyId), eq(decisions.id, sourceId), readCondition))
      .limit(1);
    if (!row) return null;
    return {
      open: row.status === "open",
      status: row.status,
      resolvedByUserId: row.decidedByUserId,
      resolvedByAgentId: null,
      resolvedAt: row.decidedAt ?? (row.status === "open" ? null : row.updatedAt),
      issueId: row.issueId,
    };
  }
  return null;
}
