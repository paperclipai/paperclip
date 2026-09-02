import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  companies,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionTrainingExamples,
  decisionTriage,
  decisions,
  heartbeatRunEvents,
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
import { deriveProjectUrlKey } from "@paperclipai/shared";
import type {
  AttentionDecisionVerb,
  AttentionFeed,
  AttentionFeedQuery,
  AttentionDetailImage,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionQueueRef,
  AttentionResolverAudience,
  AttentionSeverity,
  AttentionSortMode,
  AttentionSourceKind,
  AttentionSubject,
  AttentionTriageAttribution,
  AttentionWorkspaceRef,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionResolverPolicyProvenance,
  IssueReviewPolicy,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { PRODUCTIVITY_REVIEW_ORIGIN_KIND } from "./productivity-review.js";
import { budgetService } from "./budgets.js";
import {
  BLOCKER_ATTENTION_MAX_DEPTH,
  BLOCKER_ATTENTION_MAX_NODES,
  issueService,
} from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isProspectiveBlockedTransition } from "./routable-blocked.js";
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
const OPEN_RECOVERY_STATUSES = ["active", "escalated"] as const;
const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const PRODUCTIVITY_REVIEW_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const FAILED_RUN_STATUSES = ["failed", "timed_out"] as const;
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
  /** Internal-only escape hatch for callers that need one stable, unpaginated feed snapshot. */
  allowUnscopedAll?: boolean;
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
  dismissalKey: string,
  activityAt: string,
  now: number,
) {
  const dismissal = dismissalByKey.get(dismissalKey);
  if (!dismissal) return null;

  const dismissedAt = toIso(dismissal.dismissedAt);
  const snoozedUntil = dismissal.snoozedUntil ? toIso(dismissal.snoozedUntil) : null;
  const isActive = dismissal.kind === "snooze"
    ? dismissal.snoozedUntil != null && timestamp(dismissal.snoozedUntil) > now
    : timestamp(dismissal.dismissedAt) >= timestamp(activityAt);

  return {
    kind: dismissal.kind,
    dismissedAt,
    snoozedUntil,
    isActive,
  };
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~#-]+/g, " ")
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

type CreateAttentionItemInput = Omit<AttentionItem,
  | "id"
  | "dismissalKey"
  | "rank"
  | "dismissal"
  | "project"
  | "workspace"
  | "expiresAt"
  | "ruleKey"
  | "originAgentName"
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
    project: input.project ?? null,
    workspace: input.workspace ?? null,
    expiresAt: input.expiresAt ?? null,
    ruleKey: input.ruleKey ?? null,
    originAgentName: input.originAgentName ?? null,
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

function isDecideNow(item: AttentionItem, now: number) {
  const [bucket, deadline] = decideOrder(item, now);
  return bucket === 0 && deadline <= endOfUtcDay(now);
}

/** Surfaced today (arrival). Mirrors `attentionIsNewToday` in `ui/src/lib/attention.ts`. */
function isNewToday(item: AttentionItem, now: number) {
  const ts = timestamp(item.createdAt);
  return ts > 0 && ts >= startOfUtcDay(now);
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

async function enrichAttentionItems(db: Db, companyId: string, items: AttentionItem[], now: number) {
  if (items.length === 0) return items;
  const sourceIds = [...new Set(items.map((item) => item.subject.id))];
  const queueRows = await db
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
  const agentNameById = new Map(agentIds.length === 0 ? [] : await db
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
    return {
      ...item,
      originAgentName: originAgentId ? agentNameById.get(originAgentId) ?? null : null,
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

function approvalTitle(type: string, payload: Record<string, unknown>) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (title) return title;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return type.replaceAll("_", " ");
}

function interactionLabel(kind: string) {
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

function collapsePendingConfirmationsToNewest<T extends {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
}>(rows: T[]) {
  const newestByGroup = new Map<string, T>();
  for (const row of rows) {
    if (row.kind !== "request_confirmation") continue;
    const groupKey = `${row.issueId}:${row.kind}`;
    const newest = newestByGroup.get(groupKey);
    if (
      !newest
      || row.createdAt.getTime() > newest.createdAt.getTime()
      || (row.createdAt.getTime() === newest.createdAt.getTime() && row.id > newest.id)
    ) {
      newestByGroup.set(groupKey, row);
    }
  }

  return rows.filter((row) => (
    row.kind !== "request_confirmation"
    || newestByGroup.get(`${row.issueId}:${row.kind}`)?.id === row.id
  ));
}

function budgetObservedPercent(amountObserved: number, amountLimit: number) {
  return amountLimit > 0 ? Math.round((amountObserved / amountLimit) * 10_000) / 100 : 0;
}

async function companyPrefix(db: Db, companyId: string) {
  const row = await db
    .select({ issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return row?.issuePrefix ?? "PAP";
}

async function dismissalByKey(db: Db, companyId: string, userId: string | null | undefined) {
  if (!userId) return new Map<string, DismissalState>();
  const rows = await db
    .select({
      itemKey: inboxDismissals.itemKey,
      kind: inboxDismissals.kind,
      dismissedAt: inboxDismissals.dismissedAt,
      snoozedUntil: inboxDismissals.snoozedUntil,
    })
    .from(inboxDismissals)
    .where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId, userId)));
  return new Map(rows.map((row) => [row.itemKey, {
    kind: row.kind,
    dismissedAt: row.dismissedAt,
    snoozedUntil: row.snoozedUntil,
  }]));
}

async function issueSummaryMap(db: Db, companyId: string, issueIds: Array<string | null | undefined>) {
  const ids = [...new Set(issueIds.filter((value): value is string => Boolean(value)))];
  if (ids.length === 0) return new Map<string, IssueSummaryRow>();
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
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids), visibleIssueCondition()));
  return new Map(rows.map((row) => [row.id, {
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

async function issueImageMap(db: Db, companyId: string, issueIds: Array<string | null | undefined>) {
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
    .where(and(
      eq(issueAttachments.companyId, companyId),
      eq(assets.companyId, companyId),
      inArray(issueAttachments.issueId, ids),
      sql`${assets.contentType} like 'image/%'`,
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

async function planDocumentMap(db: Db, companyId: string, issueIds: Array<string | null | undefined>) {
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
    .where(and(
      eq(issueDocuments.companyId, companyId),
      eq(documents.companyId, companyId),
      eq(issueDocuments.key, "plan"),
      inArray(issueDocuments.issueId, ids),
    ));
  return new Map(rows.map((row) => [row.issueId, { title: row.title, body: row.body }]));
}

async function blockingIssueMap(db: Db, companyId: string, blockedIssueIds: Array<string | null | undefined>) {
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

function readRunIssueId(contextSnapshot: Record<string, unknown> | null) {
  const issueId = contextSnapshot?.issueId ?? contextSnapshot?.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

export function attentionService(db: Db, serviceOptions: AttentionServiceOptions = {}) {
  const openDecisionLimit = Math.min(
    Math.max(Math.trunc(serviceOptions.openDecisionLimit ?? OPEN_DECISION_DEFAULT_LIMIT), 1),
    OPEN_DECISION_MAX_LIMIT,
  );
  return {
    list: async (companyId: string, options: AttentionListOptions = {}): Promise<AttentionFeed> => {
      if (options.all && !options.queue && !options.allowUnscopedAll) {
        throw badRequest("all requires a queue filter");
      }
      const [prefix, dismissals] = await Promise.all([
        companyPrefix(db, companyId),
        dismissalByKey(db, companyId, options.userId),
      ]);
      const includeDismissed = options.includeDismissed === true;
      const now = serviceOptions.now?.() ?? Date.now();
      const collected: AttentionItem[] = [];

      const add = (item: AttentionItem) => {
        const dismissal = activeDismissalState(dismissals, item.dismissalKey, item.activityAt, now);
        if (!includeDismissed && dismissal?.isActive) return;
        collected.push({ ...item, dismissal });
      };

      const pendingApprovals = await db
        .select({
          id: approvals.id,
          type: approvals.type,
          status: approvals.status,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          payload: approvals.payload,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
        })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .orderBy(desc(approvals.updatedAt), desc(approvals.id));

      const pendingApprovalIds = pendingApprovals.map((approval) => approval.id);
      const approvalIssueRows = pendingApprovalIds.length > 0
        ? await db
          .select({ approvalId: issueApprovals.approvalId, issueId: issueApprovals.issueId })
          .from(issueApprovals)
          .where(and(
            eq(issueApprovals.companyId, companyId),
            inArray(issueApprovals.approvalId, pendingApprovalIds),
          ))
          .orderBy(asc(issueApprovals.approvalId), asc(issueApprovals.issueId))
        : [];
      const approvalIssueMap = new Map<string, string>();
      for (const row of approvalIssueRows) {
        if (!approvalIssueMap.has(row.approvalId)) approvalIssueMap.set(row.approvalId, row.issueId);
      }

      for (const approval of pendingApprovals) {
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
              issueId: approvalIssueMap.get(approval.id) ?? null,
            },
          },
          whyNow: "Approval is pending a board decision.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the request." },
            { id: "reject", label: "Reject", description: "Reject the request." },
            { id: "request_revision", label: "Request revision", description: "Send the request back for changes." },
          ),
          inlineResolvable: approval.type !== "request_board_approval",
          entryRule: "approvals.status = 'pending'",
          exitRule: "Approval leaves pending status.",
          dedupKey,
          severity: "medium",
          activityAt: toIso(approval.updatedAt),
          createdAt: toIso(approval.createdAt),
          updatedAt: toIso(approval.updatedAt),
          relatedIssue: null,
          detail: approvalDetail(approval.type, approval.payload),
        }));
      }

      const interactionRows = await db
        .select({
          id: issueThreadInteractions.id,
          issueId: issueThreadInteractions.issueId,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          title: issueThreadInteractions.title,
          summary: issueThreadInteractions.summary,
          payload: issueThreadInteractions.payload,
          addresseeAgentId: issueThreadInteractions.addresseeAgentId,
          addresseeUserId: issueThreadInteractions.addresseeUserId,
          createdByAgentId: issueThreadInteractions.createdByAgentId,
          requestedResolverPolicy: issueThreadInteractions.requestedResolverPolicy,
          effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
          resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
          effectiveResolverPolicySource: issueThreadInteractions.effectiveResolverPolicySource,
          createdAt: issueThreadInteractions.createdAt,
          updatedAt: issueThreadInteractions.updatedAt,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.status, [...PENDING_INTERACTION_STATUSES]),
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
        (row.addresseeAgentId === null ||
          !evaluateAgentInvokability(companyAgentMap.get(row.addresseeAgentId), companyAgentRows).invokable)
        && (row.addresseeUserId === null || row.addresseeUserId === options.userId)
      );
      const visibleInteractionRows = collapsePendingConfirmationsToNewest(boardInteractionRows);
      const [interactionIssueMap, interactionImageMap, interactionPlanDocumentMap] = await Promise.all([
        issueSummaryMap(db, companyId, visibleInteractionRows.map((row) => row.issueId)),
        issueImageMap(db, companyId, visibleInteractionRows.map((row) => row.issueId)),
        planDocumentMap(db, companyId, visibleInteractionRows.map((row) => row.issueId)),
      ]);

      for (const interaction of visibleInteractionRows) {
        const issue = interactionIssueMap.get(interaction.issueId) ?? null;
        const payload = readRecord(interaction.payload);
        const detail = interactionDetail({
          kind: interaction.kind,
          payload,
          issue,
          planDocument: interactionPlanDocumentMap.get(interaction.issueId) ?? null,
          images: issueImages(interactionImageMap, interaction.issueId),
        });
        const isPlanTarget = detail.kind === "plan_approval";
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
              isPlanTarget,
              targetDocumentKey: isPlanTarget ? "plan" : null,
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
        }));
      }

      const openDecisionQuery = db.select({
        id: decisions.id,
        bundleId: decisions.bundleId,
        originAgentId: decisions.originAgentId,
        ruleKey: decisions.ruleKey,
        title: decisions.title,
        body: decisions.body,
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
        issueSummaryMap(db, companyId, openDecisions.map((decision) => decision.originIssueId)),
        bundleIds.length > 0
          ? db.select({ id: decisionBundles.id, title: decisionBundles.title })
            .from(decisionBundles).where(and(eq(decisionBundles.companyId, companyId), inArray(decisionBundles.id, bundleIds)))
          : Promise.resolve([]),
      ]);
      for (const row of bundleRows) bundleTitleMap.set(row.id, row.title);
      for (const decision of openDecisions) {
        const issue = decisionIssueMap.get(decision.originIssueId) ?? null;
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
        }));
      }

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
        }));
      }

      const recoveryRows = await db
        .select()
        .from(issueRecoveryActions)
        .where(and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.status, [...OPEN_RECOVERY_STATUSES]),
          inArray(issueRecoveryActions.ownerType, [...HUMAN_RECOVERY_OWNER_TYPES]),
        ))
        .orderBy(desc(issueRecoveryActions.updatedAt), desc(issueRecoveryActions.id));
      const [recoveryIssueMap, recoveryImageMap] = await Promise.all([
        issueSummaryMap(
          db,
          companyId,
          recoveryRows.flatMap((row) => [row.sourceIssueId, row.recoveryIssueId]),
        ),
        issueImageMap(db, companyId, recoveryRows.map((row) => row.sourceIssueId)),
      ]);

      for (const recovery of recoveryRows) {
        const sourceIssue = recoveryIssueMap.get(recovery.sourceIssueId) ?? null;
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
          decisionVerbs: decisionVerbs(
            { id: "resolve", label: "Resolve", description: "Record the recovery outcome." },
            { id: "reassign", label: "Reassign", description: "Move the recovery to another owner." },
            { id: "cancel", label: "Cancel", description: "Cancel the recovery action." },
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
        }));
      }

      const productivityRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          originId: issues.originId,
          originFingerprint: issues.originFingerprint,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          isNotNull(issues.assigneeUserId),
          notInArray(issues.status, [...PRODUCTIVITY_REVIEW_TERMINAL_STATUSES]),
        ))
        .orderBy(desc(issues.updatedAt), desc(issues.id));
      const [productivitySourceMap, productivityReviewMap, productivityImageMap] = await Promise.all([
        issueSummaryMap(db, companyId, productivityRows.map((row) => row.originId)),
        issueSummaryMap(db, companyId, productivityRows.map((row) => row.id)),
        issueImageMap(db, companyId, productivityRows.map((row) => row.id)),
      ]);

      for (const review of productivityRows) {
        const reviewIssue = productivityReviewMap.get(review.id);
        if (!reviewIssue) continue;
        const sourceIssue = review.originId ? productivitySourceMap.get(review.originId) ?? null : null;
        const dedupKey = `productivity_review:${review.originFingerprint ?? review.originId ?? review.id}`;
        add(createItem({
          companyId,
          sourceKind: "productivity_review",
          subject: issueSubject(prefix, reviewIssue),
          whyNow: "Productivity review is awaiting a human decision.",
          decisionVerbs: decisionVerbs(
            { id: "resolve", label: "Resolve", description: "Record a productivity review outcome." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this review for now." },
            { id: "reassign", label: "Reassign", description: "Move the review to another owner." },
          ),
          inlineResolvable: false,
          entryRule: "Open issue_productivity_review issue assigned to a user.",
          exitRule: "Review issue is done/cancelled or no longer assigned to a user.",
          dedupKey,
          severity: review.priority === "critical" ? "critical" : review.priority === "high" ? "high" : "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: sourceIssue ? issueSubject(prefix, sourceIssue) : null,
          ...issueContext(reviewIssue),
          detail: genericDetail(sourceIssue?.title ?? review.title, issueImages(productivityImageMap, review.id)),
        }));
      }

      const blockedIssues = await issueService(db).list(companyId, { status: "blocked", includeBlockedBy: true });
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
      const terminalBlockerIssueIds = typedBlockedIssues
        .map((issue) => issue.blockerAttention?.terminalBlockerIssueId)
        .filter((issueId): issueId is string => Boolean(issueId));
      const [blockedIssueSummaries, terminalBlockerSummaries, blockerImageMap, blockingIssues] = await Promise.all([
        issueSummaryMap(db, companyId, blockedIssues.map((issue) => issue.id)),
        issueSummaryMap(db, companyId, terminalBlockerIssueIds),
        issueImageMap(
          db,
          companyId,
          [...blockedIssues.map((issue) => issue.id), ...terminalBlockerIssueIds],
        ),
        blockingIssueMap(db, companyId, blockedIssues.map((issue) => issue.id)),
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
          }));
        }
        const blockerAttention = issue.blockerAttention;
        if (blockerAttention?.state !== "stalled" && blockerAttention?.state !== "needs_attention") continue;
        if (blockerAttention.blockingTreeLive) continue;
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

      const blockedWorkCounts = await blockedWorkCountMap(db, companyId, [...terminalCandidates.keys()]);
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
        }));
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
        .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), visibleIssueCondition()))
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
          ));
      const pendingApprovalByIssueId = new Map(pendingReviewApprovalRows.map((row) => [row.issueId, row.approvalId]));
      const [reviewAttentionByIssueId, reviewIssueMap, reviewImageMap] = await Promise.all([
        issueService(db).listReviewAttention(companyId, reviewRows),
        issueSummaryMap(db, companyId, reviewIssueIds),
        issueImageMap(db, companyId, reviewIssueIds),
      ]);

      for (const review of reviewRows) {
        const state = parseIssueExecutionState(review.executionState);
        const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId = pendingApprovalByIssueId.get(review.id) ?? null;
        const reviewAttention = reviewAttentionByIssueId.get(review.id);
        const stalled = reviewAttention?.state === "stalled";
        if (!hasHumanParticipant && !review.assigneeUserId && !pendingApprovalId && !stalled) continue;
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
        }));
      }

      const exhaustedRunRows = await db
        .select({
          id: heartbeatRuns.id,
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
          finishedAt: heartbeatRuns.finishedAt,
          exhaustionMessage: heartbeatRunEvents.message,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .innerJoin(heartbeatRunEvents, eq(heartbeatRunEvents.runId, heartbeatRuns.id))
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(agents.companyId, companyId),
          notInArray(agents.status, ["terminated"]),
          inArray(heartbeatRuns.status, [...FAILED_RUN_STATUSES]),
          eq(heartbeatRunEvents.companyId, companyId),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
          sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
        ))
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRunEvents.id));

      const latestExhaustedByRunId = new Map<string, (typeof exhaustedRunRows)[number]>();
      for (const row of exhaustedRunRows) {
        if (!latestExhaustedByRunId.has(row.id)) latestExhaustedByRunId.set(row.id, row);
      }
      const failedRows = [...latestExhaustedByRunId.values()];
      const failedIssueIds = failedRows.map((row) => readRunIssueId(row.contextSnapshot));
      const failedAgentIds = [...new Set(failedRows.map((row) => row.agentId))];
      const oldestFailedRunCreatedAt = failedRows.reduce<Date | null>((oldest, row) => {
        if (!oldest || row.createdAt < oldest) return row.createdAt;
        return oldest;
      }, null);
      const [failedIssueMap, failedImageMap, newerRuns] = await Promise.all([
        issueSummaryMap(
          db,
          companyId,
          failedIssueIds,
        ),
        issueImageMap(db, companyId, failedIssueIds),
        oldestFailedRunCreatedAt && failedAgentIds.length > 0
          ? db
            .select({
              agentId: heartbeatRuns.agentId,
              createdAt: heartbeatRuns.createdAt,
              // Project just the ids readRunIssueId needs; pulling the whole
              // context_snapshot detoasts megabytes per feed build.
              runIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
              runTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
            })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.agentId, failedAgentIds),
              gt(heartbeatRuns.createdAt, oldestFailedRunCreatedAt),
            ))
          : Promise.resolve([]),
      ]);
      const latestRunCreatedAtByKey = new Map<string, Date>();
      for (const newerRun of newerRuns) {
        const newerRunIssueId = readRunIssueId({ issueId: newerRun.runIssueId, taskId: newerRun.runTaskId });
        const newerRunKey = `${newerRun.agentId}:${newerRunIssueId ?? ""}`;
        const latestCreatedAt = latestRunCreatedAtByKey.get(newerRunKey);
        if (!latestCreatedAt || newerRun.createdAt > latestCreatedAt) {
          latestRunCreatedAtByKey.set(newerRunKey, newerRun.createdAt);
        }
      }
      for (const run of failedRows) {
        const issueId = readRunIssueId(run.contextSnapshot);
        const runKey = `${run.agentId}:${issueId ?? ""}`;
        const hasNewerRun = (latestRunCreatedAtByKey.get(runKey)?.getTime() ?? 0) > run.createdAt.getTime();
        if (hasNewerRun) continue;

        const issue = issueId ? failedIssueMap.get(issueId) ?? null : null;
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
              error: run.error,
              retryExhaustedReason: run.exhaustionMessage,
            },
          },
          whyNow: "Run failed after automatic retries were exhausted.",
          decisionVerbs: decisionVerbs(
            { id: "retry", label: "Retry", description: "Retry the failed run or issue." },
            { id: "reassign", label: "Reassign", description: "Move the work to another owner." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this failed-run attention row." },
          ),
          inlineResolvable: true,
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
            failureReasonExcerpt: excerpt(run.error ?? run.exhaustionMessage ?? run.errorCode),
            images: issueImages(failedImageMap, issueId),
          },
        }));
      }

      const budgetOverview = await budgetService(db).overview(companyId);
      for (const incident of budgetOverview.activeIncidents) {
        const observedPercent = budgetObservedPercent(incident.amountObserved, incident.amountLimit);
        if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
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
            { id: "raise_budget_and_resume", label: "Raise budget", description: "Raise the budget and resume paused work." },
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
        }));
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
        .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")))
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
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the agent error." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this alert." },
          ),
          inlineResolvable: true,
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
        }));
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      const collectedItems = [...deduped.values()].sort(compareAttentionItems);
      await decisionQueueService(db).materializeSeededQueues(companyId, collectedItems);
      const enrichedItems = await enrichAttentionItems(db, companyId, collectedItems, now);

      const activitySince = parseActivityBoundary(options.activitySince, "activitySince");
      const activityUntil = parseActivityBoundary(options.activityUntil, "activityUntil");
      if (activitySince != null && activityUntil != null && activitySince > activityUntil) {
        throw badRequest("activitySince must be before or equal to activityUntil");
      }
      const queueKey = options.queue?.trim() || null;
      const visibleItems = enrichedItems.filter((item) => {
        if (options.archived === true ? !item.archivedAt : Boolean(item.archivedAt)) return false;
        if (!includeDismissed && item.snoozedUntil && timestamp(item.snoozedUntil) > now) return false;
        const activity = timestamp(item.activityAt);
        if (activitySince != null && activity < activitySince) return false;
        if (activityUntil != null && activity > activityUntil) return false;
        if (queueKey && !item.queues.some((queue) => queue.key === queueKey)) return false;
        return true;
      });

      const sort = options.sort ?? "activity";
      if (sort !== "activity" && sort !== "decide") throw badRequest("sort must be 'activity' or 'decide'");
      const selectedComparator = sort === "decide"
        ? (left: AttentionItem, right: AttentionItem) => compareDecideItems(left, right, now)
        : compareAttentionItems;
      const rankedItems = orderBlockedAttentionByWeight(
        visibleItems.sort(selectedComparator),
        selectedComparator,
      )
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
      const countsBySourceKind = emptyCounts();
      for (const item of rankedItems) countsBySourceKind[item.sourceKind] += 1;

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: rankedItems.length,
        // Desk badge: distinct items that surfaced
        // today OR carry an explicit decide-by deadline due today/past. Counted
        // over the full ranked set (pre-pagination) so the sidebar badge stays
        // company-wide accurate even on a small first page.
        deskBadgeCount: rankedItems.filter((item) => isNewToday(item, now) || isDecideNow(item, now)).length,
        nextCursor,
        countsBySourceKind,
        items,
      };
    },
  };
}
