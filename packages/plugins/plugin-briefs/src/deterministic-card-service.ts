import { randomUUID } from "node:crypto";
import type {
  BriefCard,
  BriefCardSource,
  BriefCardState,
  BriefCursorEvent,
  BriefPreferences,
  BriefSnapshot,
  BriefSummaryFailureReason,
  BriefSummaryStatus,
  BriefTaskRow,
} from "./contracts.js";

export type BriefIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type BriefsIssueInput = {
  id: string;
  companyId: string;
  parentId: string | null;
  title: string;
  identifier: string | null;
  status: BriefIssueStatus | string;
  priority?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  activeRecoveryAction?: unknown | null;
  blockerAttention?: { reason?: string | null } | null;
  executionState?: {
    currentParticipant?: { type?: string; userId?: string | null; agentId?: string | null } | null;
    returnAssignee?: { type?: string; userId?: string | null; agentId?: string | null } | null;
  } | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  completedAt?: Date | string | null;
};

export type BriefsRelationInput = {
  blockedBy?: Array<{
    id: string;
    companyId?: string | null;
    identifier?: string | null;
    title?: string | null;
    status?: BriefIssueStatus | string | null;
  }>;
};

export type BriefsRunInput = {
  id: string;
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
  error?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

export type BriefsCommentInput = {
  id: string;
  companyId: string;
  issueId: string;
  authorUserId?: string | null;
  body?: string | null;
  createdAt?: Date | string | null;
};

export type BriefsDocumentInput = {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title?: string | null;
  createdByUserId?: string | null;
  updatedByUserId?: string | null;
  updatedAt?: Date | string | null;
};

export type BriefsInteractionInput = {
  id: string;
  companyId: string;
  issueId: string;
  kind: "request_confirmation" | "ask_user_questions" | "suggest_tasks" | string;
  status: "pending" | "answered" | "accepted" | "rejected" | "cancelled" | string;
  targetUserId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type BriefsApprovalInput = {
  id: string;
  companyId: string;
  issueId: string;
  status: "pending_approval" | "approved" | "rejected" | string;
  reviewerUserId?: string | null;
  decidedByUserId?: string | null;
  createdAt?: Date | string | null;
  decidedAt?: Date | string | null;
};

export type BriefsWorkProductInput = {
  id: string;
  companyId: string;
  issueId: string;
  title: string;
  status?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type BriefsActivityEventInput = {
  id: string;
  companyId: string;
  issueId?: string | null;
  action: string;
  createdAt?: Date | string | null;
};

export type BriefsSourceBundle = {
  companyId: string;
  userId: string;
  rootIssueId: string;
  issues: BriefsIssueInput[];
  relations?: Record<string, BriefsRelationInput>;
  activeRuns?: Record<string, BriefsRunInput[]>;
  runs?: BriefsRunInput[];
  comments?: BriefsCommentInput[];
  documents?: BriefsDocumentInput[];
  interactions?: BriefsInteractionInput[];
  approvals?: BriefsApprovalInput[];
  workProducts?: BriefsWorkProductInput[];
  activityEvents?: BriefsActivityEventInput[];
  relevantAgentIds?: string[];
  groupingDescription?: string | null;
  title?: string | null;
};

export type DeterministicBriefOptions = {
  now?: Date | string;
  pinned?: boolean;
  hidden?: boolean;
  title?: string | null;
  summaryStatus?: BriefSummaryStatus;
  summaryParagraph?: string | null;
  summaryFailureReason?: BriefSummaryFailureReason | null;
  summaryModel?: string | null;
  summaryTokensIn?: number | null;
  summaryTokensOut?: number | null;
  generatedByAgentId?: string | null;
  generatedByRunId?: string | null;
  allowGeneratedSummary?: boolean;
  preferences?: Partial<BriefPreferences>;
  idFactory?: () => string;
};

export type BriefCursorDedupeResult = {
  freshEvents: BriefCursorEvent[];
  dedupeState: string[];
  lastSeenAt: string | null;
};

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_DONE_RETENTION_HOURS = 72;
const DEFAULT_STALE_AFTER_DAYS = 7;
const DEFAULT_DISCOVERY_WINDOW_DAYS = 14;
const LIVE_WINDOW_HOURS = 6;
const FAILED_RUN_WINDOW_HOURS = 24;
const MAX_DEDUPE_STATE = 500;

const BLOCKER_ATTENTION_REASONS = new Set([
  "owner_paused",
  "recovery_required",
  "external_wait",
  "needs_attention",
  "stalled",
]);

function asTime(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function toIso(value: number | Date | string): string {
  const date = typeof value === "number" ? new Date(value) : value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function addMs(time: number, amount: number): number {
  return time + amount;
}

function days(value: number): number {
  return value * 24 * 60 * 60 * 1000;
}

function hours(value: number): number {
  return value * 60 * 60 * 1000;
}

function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function slugifyBriefGrouping(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 96) || "brief";
}

function issueHref(issue: Pick<BriefsIssueInput, "id" | "identifier">): string {
  const prefix = companyPrefixFromIdentifier(issue.identifier) ?? "PAP";
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function sourceIssue(bundle: BriefsSourceBundle, issueId: string | null | undefined): BriefsIssueInput | null {
  if (!issueId) return null;
  return bundle.issues.find((issue) => issue.id === issueId) ?? null;
}

function companyPrefixFromIdentifier(identifier: string | null | undefined): string | null {
  return identifier?.match(/^([A-Z][A-Z0-9]*)-\d+$/)?.[1] ?? null;
}

function companyPrefixForBundle(bundle: BriefsSourceBundle): string {
  return bundle.issues.map((issue) => companyPrefixFromIdentifier(issue.identifier)).find(Boolean) ?? "PAP";
}

function sourceLink(
  bundle: BriefsSourceBundle,
  kind: string,
  sourceId: string,
  issueId: string | null,
  key?: string,
  agentId?: string | null,
): string {
  const issue = sourceIssue(bundle, issueId);
  const prefix = issue ? companyPrefixFromIdentifier(issue.identifier) ?? companyPrefixForBundle(bundle) : companyPrefixForBundle(bundle);
  if (kind === "run") {
    return agentId ? `/${prefix}/agents/${agentId}/runs/${sourceId}` : issue ? issueHref(issue) : `/${prefix}/issues/${issueId ?? sourceId}`;
  }
  if (!issue) return `/${prefix}/issues/${issueId ?? sourceId}`;
  if (kind === "comment") return `${issueHref(issue)}#comment-${sourceId}`;
  if (kind === "document") return `${issueHref(issue)}#document-${key ?? sourceId}`;
  if (kind === "interaction") return `${issueHref(issue)}#interaction-${sourceId}`;
  if (kind === "approval") return `/${prefix}/approvals/${sourceId}`;
  if (kind === "work_product") return `${issueHref(issue)}#work-product-${sourceId}`;
  return issueHref(issue);
}

function eventTime(...values: Array<Date | string | null | undefined>): number {
  return Math.max(0, ...values.map(asTime).filter((time): time is number => time != null));
}

function issueEventTime(issue: BriefsIssueInput): number {
  return eventTime(issue.completedAt, issue.updatedAt, issue.createdAt);
}

function runEventTime(run: BriefsRunInput): number {
  return eventTime(run.finishedAt, run.startedAt, run.createdAt);
}

function assertCompanyScope(bundle: BriefsSourceBundle): void {
  const issueIds = new Set(bundle.issues.map((issue) => issue.id));
  const check = (label: string, companyId: string, sourceId: string) => {
    if (companyId !== bundle.companyId) {
      throw new Error(`Briefs source ${label}:${sourceId} belongs to another company`);
    }
  };

  for (const issue of bundle.issues) check("issue", issue.companyId, issue.id);
  for (const run of [...Object.values(bundle.activeRuns ?? {}).flat(), ...(bundle.runs ?? [])]) check("run", run.companyId, run.id);
  for (const comment of bundle.comments ?? []) check("comment", comment.companyId, comment.id);
  for (const document of bundle.documents ?? []) check("document", document.companyId, document.id);
  for (const interaction of bundle.interactions ?? []) check("interaction", interaction.companyId, interaction.id);
  for (const approval of bundle.approvals ?? []) check("approval", approval.companyId, approval.id);
  for (const workProduct of bundle.workProducts ?? []) check("work_product", workProduct.companyId, workProduct.id);
  for (const event of bundle.activityEvents ?? []) check("activity_event", event.companyId, event.id);

  for (const [issueId, relation] of Object.entries(bundle.relations ?? {})) {
    if (!issueIds.has(issueId)) {
      throw new Error(`Briefs relation references issue outside the source bundle: ${issueId}`);
    }
    for (const blocker of relation.blockedBy ?? []) {
      if (blocker.companyId && blocker.companyId !== bundle.companyId) {
        throw new Error(`Briefs blocker ${blocker.id} belongs to another company`);
      }
    }
  }
}

function getRootIssue(bundle: BriefsSourceBundle): BriefsIssueInput {
  const root = bundle.issues.find((issue) => issue.id === bundle.rootIssueId);
  if (!root) throw new Error(`Root issue not found in Briefs source bundle: ${bundle.rootIssueId}`);
  return root;
}

function getIssueIds(bundle: BriefsSourceBundle): Set<string> {
  return new Set(bundle.issues.map((issue) => issue.id));
}

function activeRuns(bundle: BriefsSourceBundle): BriefsRunInput[] {
  return [
    ...Object.values(bundle.activeRuns ?? {}).flat(),
    ...(bundle.runs ?? []).filter((run) => ["queued", "running", "in_progress"].includes(run.status)),
  ];
}

function failedRunsWithinWindow(bundle: BriefsSourceBundle, nowMs: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of bundle.runs ?? []) {
    if (!run.issueId || !["failed", "error"].includes(run.status)) continue;
    const at = runEventTime(run);
    if (!at || nowMs - at > hours(FAILED_RUN_WINDOW_HOURS)) continue;
    counts.set(run.issueId, (counts.get(run.issueId) ?? 0) + 1);
  }
  return counts;
}

function hasOutOfTreeBlocker(issue: BriefsIssueInput, relation: BriefsRelationInput | undefined, treeIssueIds: Set<string>): boolean {
  if (issue.status !== "blocked") return false;
  for (const blocker of relation?.blockedBy ?? []) {
    if (["done", "cancelled"].includes(String(blocker.status))) continue;
    if (!treeIssueIds.has(blocker.id)) return true;
  }
  return false;
}

function issueHasBlockingAttention(issue: BriefsIssueInput): boolean {
  const reason = issue.blockerAttention?.reason;
  return Boolean(reason && BLOCKER_ATTENTION_REASONS.has(reason));
}

function participantIsUser(
  participant: BriefsIssueInput["executionState"] extends infer T
    ? T extends { currentParticipant?: infer P } ? P : never
    : never,
  userId: string,
): boolean {
  return Boolean(participant && typeof participant === "object" && "type" in participant && participant.type === "user" && participant.userId === userId);
}

function issueWaitingOnUser(issue: BriefsIssueInput, userId: string): boolean {
  return issue.assigneeUserId === userId
    || participantIsUser(issue.executionState?.currentParticipant ?? null, userId)
    || participantIsUser(issue.executionState?.returnAssignee ?? null, userId);
}

function issueHasTypedReviewer(issue: BriefsIssueInput): boolean {
  const participant = issue.executionState?.currentParticipant;
  return issue.status === "in_review" && Boolean(participant?.type === "user" || participant?.type === "agent");
}

function pendingInteractionForUser(interaction: BriefsInteractionInput, userId: string): boolean {
  return interaction.status === "pending" && (!interaction.targetUserId || interaction.targetUserId === userId);
}

function pendingApprovalForUser(approval: BriefsApprovalInput, userId: string): boolean {
  return approval.status === "pending_approval" && approval.reviewerUserId === userId;
}

function pendingApprovalForOtherReviewer(approval: BriefsApprovalInput, userId: string): boolean {
  return approval.status === "pending_approval" && approval.reviewerUserId !== userId;
}

function lastMeaningfulEventMs(bundle: BriefsSourceBundle): number {
  return Math.max(
    ...bundle.issues.map(issueEventTime),
    ...Object.values(bundle.activeRuns ?? {}).flat().map(runEventTime),
    ...(bundle.runs ?? []).map(runEventTime),
    ...(bundle.comments ?? []).map((comment) => eventTime(comment.createdAt)),
    ...(bundle.documents ?? []).map((document) => eventTime(document.updatedAt)),
    ...(bundle.interactions ?? []).map((interaction) => eventTime(interaction.updatedAt, interaction.createdAt)),
    ...(bundle.approvals ?? []).map((approval) => eventTime(approval.decidedAt, approval.createdAt)),
    ...(bundle.workProducts ?? []).map((workProduct) => eventTime(workProduct.updatedAt, workProduct.createdAt)),
    ...(bundle.activityEvents ?? []).map((activity) => eventTime(activity.createdAt)),
  );
}

export function resolveBriefCardState(bundle: BriefsSourceBundle, options: { now?: Date | string; preferences?: Partial<BriefPreferences> } = {}): {
  state: BriefCardState;
  inputs: Record<string, unknown>;
} {
  assertCompanyScope(bundle);
  const nowMs = asTime(options.now ?? new Date()) ?? Date.now();
  const root = getRootIssue(bundle);
  const treeIssueIds = getIssueIds(bundle);
  const failedRunCounts = failedRunsWithinWindow(bundle, nowMs);
  const lastEventMs = lastMeaningfulEventMs(bundle);
  const doneRetentionHours = options.preferences?.doneRetentionHours ?? DEFAULT_DONE_RETENTION_HOURS;

  const hasRecoveryAction = bundle.issues.some((issue) => Boolean(issue.activeRecoveryAction));
  const hasFailedRunLoop = [...failedRunCounts.values()].some((count) => count >= 3);
  const hasBlocked = bundle.issues.some((issue) => hasOutOfTreeBlocker(issue, bundle.relations?.[issue.id], treeIssueIds) || issueHasBlockingAttention(issue));
  const hasWaitingUser = bundle.issues.some((issue) => issueWaitingOnUser(issue, bundle.userId))
    || (bundle.interactions ?? []).some((interaction) => pendingInteractionForUser(interaction, bundle.userId))
    || (bundle.approvals ?? []).some((approval) => pendingApprovalForUser(approval, bundle.userId));
  const hasWaitingReviewer = bundle.issues.some((issue) => issueHasTypedReviewer(issue) && !issueWaitingOnUser(issue, bundle.userId))
    || (bundle.approvals ?? []).some((approval) => pendingApprovalForOtherReviewer(approval, bundle.userId));
  const hasLive = (activeRuns(bundle).length > 0 || bundle.issues.some((issue) => issue.status === "in_progress"))
    && lastEventMs > 0
    && nowMs - lastEventMs <= hours(LIVE_WINDOW_HOURS);
  const doneAt = asTime(root.completedAt) ?? (root.status === "done" ? issueEventTime(root) : null);
  const isRecentlyDone = root.status === "done" && doneAt != null && nowMs - doneAt <= hours(doneRetentionHours);

  const inputs = {
    hasRecoveryAction,
    hasFailedRunLoop,
    hasBlocked,
    hasWaitingUser,
    hasWaitingReviewer,
    hasLive,
    isRecentlyDone,
    lastMeaningfulEventAt: lastEventMs ? toIso(lastEventMs) : null,
  };

  if (hasRecoveryAction || hasFailedRunLoop) return { state: "error", inputs };
  if (hasBlocked) return { state: "blocked", inputs };
  if (hasWaitingUser) return { state: "waiting-user", inputs };
  if (hasWaitingReviewer) return { state: "waiting-reviewer", inputs };
  if (hasLive) return { state: "live", inputs };
  if (isRecentlyDone) return { state: "done", inputs };
  return { state: "stale", inputs };
}

function sourcePriority(source: BriefCardSource): number {
  if (source.rightTag === "blocked") return 0;
  if (source.rightTag === "asked you") return 1;
  if (source.rightTag === "in_review" || source.rightTag === "approval") return 2;
  if (source.rightTag === "running" || source.rightTag === "in_progress") return 3;
  if (source.rightTag === "failed") return 4;
  return 5;
}

function toTaskRow(source: BriefCardSource): BriefTaskRow | null {
  if (!["issue", "run", "comment", "document", "interaction", "approval"].includes(source.sourceKind)) return null;
  return {
    kind: source.sourceKind as BriefTaskRow["kind"],
    sourceId: source.sourceId,
    issueId: source.issueId,
    identifier: source.identifier,
    titleLine: truncate(source.titleLine, 120),
    rightTag: source.rightTag,
    linkPath: source.linkPath,
    isIntraTreeBlocked: source.isIntraTreeBlocked,
    eventAt: source.eventAt,
  };
}

function taskRowDedupeKey(row: BriefTaskRow): string {
  return row.issueId || row.identifier || `${row.kind}:${row.sourceId}`;
}

function taskRowTime(row: BriefTaskRow): number {
  return new Date(row.eventAt).getTime() || 0;
}

export function dedupeBriefTaskRows(rows: BriefTaskRow[]): BriefTaskRow[] {
  const byKey = new Map<string, BriefTaskRow>();
  for (const row of rows) {
    const key = taskRowDedupeKey(row);
    const current = byKey.get(key);
    if (!current || taskRowTime(row) > taskRowTime(current)) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => taskRowTime(b) - taskRowTime(a));
}

function issueRightTag(issue: BriefsIssueInput, bundle: BriefsSourceBundle, treeIssueIds: Set<string>): { tag: string; intraTreeBlocked: boolean | null } {
  if (issue.status === "blocked") {
    const relation = bundle.relations?.[issue.id];
    const blockers = relation?.blockedBy ?? [];
    const hasOnlyInTreeBlockers = blockers.length > 0 && blockers.every((blocker) => treeIssueIds.has(blocker.id));
    return { tag: "blocked", intraTreeBlocked: hasOnlyInTreeBlockers };
  }
  if (issueWaitingOnUser(issue, bundle.userId)) return { tag: "asked you", intraTreeBlocked: null };
  return { tag: String(issue.status), intraTreeBlocked: null };
}

function buildSources(bundle: BriefsSourceBundle, cardId: string, idFactory: () => string): BriefCardSource[] {
  const treeIssueIds = getIssueIds(bundle);
  const issueSources: BriefCardSource[] = bundle.issues.map((issue) => {
    const right = issueRightTag(issue, bundle, treeIssueIds);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "issue",
      sourceId: issue.id,
      issueId: issue.id,
      identifier: issue.identifier,
      titleLine: truncate(issue.title, 160),
      rightTag: right.tag,
      linkPath: issueHref(issue),
      isIntraTreeBlocked: right.intraTreeBlocked,
      eventAt: toIso(issueEventTime(issue) || Date.now()),
      metadata: { priority: issue.priority ?? null },
    };
  });

  const runSources = [
    ...Object.values(bundle.activeRuns ?? {}).flat(),
    ...(bundle.runs ?? []),
  ].map((run): BriefCardSource => {
    const issue = sourceIssue(bundle, run.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "run",
      sourceId: run.id,
      issueId: run.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(issue ? `Run for ${issue.title}` : "Heartbeat run", 160),
      rightTag: ["failed", "error"].includes(run.status) ? "failed" : run.status,
      linkPath: sourceLink(bundle, "run", run.id, run.issueId, undefined, run.agentId),
      isIntraTreeBlocked: null,
      eventAt: toIso(runEventTime(run) || Date.now()),
      metadata: { error: run.error ?? null },
    };
  });

  const commentSources = (bundle.comments ?? []).map((comment): BriefCardSource => {
    const issue = sourceIssue(bundle, comment.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "comment",
      sourceId: comment.id,
      issueId: comment.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(comment.body || `Comment on ${issue?.title ?? "issue"}`, 160),
      rightTag: "comment",
      linkPath: sourceLink(bundle, "comment", comment.id, comment.issueId),
      isIntraTreeBlocked: null,
      eventAt: toIso(eventTime(comment.createdAt) || Date.now()),
      metadata: { authorUserId: comment.authorUserId ?? null },
    };
  });

  const documentSources = (bundle.documents ?? []).map((document): BriefCardSource => {
    const issue = sourceIssue(bundle, document.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "document",
      sourceId: document.id,
      issueId: document.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(document.title ?? document.key, 160),
      rightTag: "document",
      linkPath: sourceLink(bundle, "document", document.id, document.issueId, document.key),
      isIntraTreeBlocked: null,
      eventAt: toIso(eventTime(document.updatedAt) || Date.now()),
      metadata: { key: document.key },
    };
  });

  const interactionSources = (bundle.interactions ?? []).map((interaction): BriefCardSource => {
    const issue = sourceIssue(bundle, interaction.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "interaction",
      sourceId: interaction.id,
      issueId: interaction.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(interaction.kind.replaceAll("_", " "), 160),
      rightTag: pendingInteractionForUser(interaction, bundle.userId) ? "asked you" : interaction.status,
      linkPath: sourceLink(bundle, "interaction", interaction.id, interaction.issueId),
      isIntraTreeBlocked: null,
      eventAt: toIso(eventTime(interaction.updatedAt, interaction.createdAt) || Date.now()),
      metadata: { kind: interaction.kind, targetUserId: interaction.targetUserId ?? null },
    };
  });

  const approvalSources = (bundle.approvals ?? []).map((approval): BriefCardSource => {
    const issue = sourceIssue(bundle, approval.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "approval",
      sourceId: approval.id,
      issueId: approval.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(`Approval for ${issue?.title ?? "issue"}`, 160),
      rightTag: approval.status === "pending_approval" ? "approval" : approval.status,
      linkPath: sourceLink(bundle, "approval", approval.id, approval.issueId),
      isIntraTreeBlocked: null,
      eventAt: toIso(eventTime(approval.decidedAt, approval.createdAt) || Date.now()),
      metadata: { reviewerUserId: approval.reviewerUserId ?? null },
    };
  });

  const workProductSources = (bundle.workProducts ?? []).map((workProduct): BriefCardSource => {
    const issue = sourceIssue(bundle, workProduct.issueId);
    return {
      id: idFactory(),
      companyId: bundle.companyId,
      userId: bundle.userId,
      cardId,
      sourceKind: "work_product",
      sourceId: workProduct.id,
      issueId: workProduct.issueId,
      identifier: issue?.identifier ?? null,
      titleLine: truncate(workProduct.title, 160),
      rightTag: workProduct.status ?? "work product",
      linkPath: sourceLink(bundle, "work_product", workProduct.id, workProduct.issueId),
      isIntraTreeBlocked: null,
      eventAt: toIso(eventTime(workProduct.updatedAt, workProduct.createdAt) || Date.now()),
      metadata: {},
    };
  });

  const activitySources = (bundle.activityEvents ?? []).map((activity): BriefCardSource => ({
    id: idFactory(),
    companyId: bundle.companyId,
    userId: bundle.userId,
    cardId,
    sourceKind: "activity_event",
    sourceId: activity.id,
    issueId: activity.issueId ?? null,
    identifier: sourceIssue(bundle, activity.issueId)?.identifier ?? null,
    titleLine: truncate(activity.action, 160),
    rightTag: "activity",
    linkPath: sourceLink(bundle, "activity_event", activity.id, activity.issueId ?? null),
    isIntraTreeBlocked: null,
    eventAt: toIso(eventTime(activity.createdAt) || Date.now()),
    metadata: { action: activity.action },
  }));

  return [
    ...issueSources,
    ...runSources,
    ...commentSources,
    ...documentSources,
    ...interactionSources,
    ...approvalSources,
    ...workProductSources,
    ...activitySources,
  ].sort((a, b) => sourcePriority(a) - sourcePriority(b) || new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime());
}

function fallbackSummary(state: BriefCardState, rows: BriefTaskRow[]): string {
  const row = rows[0];
  if (!row) return "No current source rows are available for this brief.";
  if (state === "blocked") return `${row.identifier ?? "A source issue"} is blocked and needs out-of-tree progress.`;
  if (state === "waiting-user") return `${row.identifier ?? "A source item"} is waiting on your response.`;
  if (state === "waiting-reviewer") return `${row.identifier ?? "A source item"} is in review with a typed reviewer.`;
  if (state === "live") return `${row.identifier ?? "A source issue"} is active with recent work in progress.`;
  if (state === "done") return `${row.identifier ?? "The root issue"} was completed recently.`;
  if (state === "error") return `${row.identifier ?? "A source issue"} has a recovery or repeated run failure signal.`;
  return `${row.identifier ?? "This area"} has no recent meaningful activity.`;
}

export function buildDeterministicBriefCard(bundle: BriefsSourceBundle, options: DeterministicBriefOptions = {}): BriefCard {
  assertCompanyScope(bundle);
  const root = getRootIssue(bundle);
  const idFactory = options.idFactory ?? randomUUID;
  const cardId = idFactory();
  const snapshotId = idFactory();
  const nowMs = asTime(options.now ?? new Date()) ?? Date.now();
  const lastEventMs = lastMeaningfulEventMs(bundle) || nowMs;
  const stateResult = resolveBriefCardState(bundle, options);
  const summaryStatus = options.summaryStatus ?? "fallback";
  const groupingDescription = truncate(
    bundle.groupingDescription ?? `Issue tree rooted at ${root.identifier ?? root.id}: ${root.title}`,
    500,
  );
  const slug = slugifyBriefGrouping(groupingDescription);
  const sources = buildSources(bundle, cardId, idFactory);
  const taskRows = dedupeBriefTaskRows(sources.map(toTaskRow).filter((row): row is BriefTaskRow => Boolean(row))).slice(0, 3);
  const staleAt = addMs(lastEventMs, days(options.preferences?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS));
  const retentionMs = stateResult.state === "done"
    ? hours(options.preferences?.doneRetentionHours ?? DEFAULT_DONE_RETENTION_HOURS)
    : days(options.preferences?.retentionDays ?? DEFAULT_RETENTION_DAYS);
  const pinned = options.pinned ?? false;
  const summaryParagraph = summaryStatus === "ok"
    ? truncate(options.summaryParagraph ?? fallbackSummary(stateResult.state, taskRows), 900)
    : null;

  const snapshot: BriefSnapshot = {
    id: snapshotId,
    companyId: bundle.companyId,
    userId: bundle.userId,
    cardId,
    summaryParagraph,
    summaryStatus,
    summaryModel: options.summaryModel ?? null,
    summaryTokensIn: options.summaryTokensIn ?? null,
    summaryTokensOut: options.summaryTokensOut ?? null,
    summaryFailureReason: summaryStatus === "fallback" ? options.summaryFailureReason ?? "model_error" : null,
    taskRows,
    evidenceSourceIds: summaryStatus === "ok" ? taskRows.map((row) => row.sourceId) : [],
    generatedByAgentId: options.generatedByAgentId ?? null,
    generatedByRunId: options.generatedByRunId ?? null,
    deterministicStateInputs: stateResult.inputs,
    createdAt: toIso(nowMs),
  };

  return {
    id: cardId,
    companyId: bundle.companyId,
    userId: bundle.userId,
    slug,
    title: truncate(options.title ?? bundle.title ?? root.title, 90),
    groupingDescription,
    rootIssueId: root.id,
    state: stateResult.state,
    summaryStatus,
    pinned,
    hidden: options.hidden ?? false,
    staleAt: toIso(staleAt),
    expiresAt: pinned ? null : toIso(addMs(lastEventMs, retentionMs)),
    latestSnapshotId: snapshotId,
    lastMeaningfulEventAt: toIso(lastEventMs),
    snapshot,
    sources,
    moreSourceCount: Math.max(0, sources.length - taskRows.length),
  };
}

export function isBriefTreeRelevantToUser(bundle: BriefsSourceBundle): boolean {
  assertCompanyScope(bundle);
  return bundle.issues.some((issue) => issue.createdByUserId === bundle.userId || issue.updatedByUserId === bundle.userId || issueWaitingOnUser(issue, bundle.userId))
    || (bundle.comments ?? []).some((comment) => comment.authorUserId === bundle.userId)
    || (bundle.documents ?? []).some((document) => document.createdByUserId === bundle.userId || document.updatedByUserId === bundle.userId)
    || (bundle.interactions ?? []).some((interaction) => interaction.targetUserId === bundle.userId)
    || (bundle.approvals ?? []).some((approval) => approval.reviewerUserId === bundle.userId || approval.decidedByUserId === bundle.userId);
}

export function selectRelevantBriefTrees(input: {
  companyId: string;
  userId: string;
  candidateTrees: BriefsSourceBundle[];
  now?: Date | string;
  discoveryWindowDays?: number;
}): BriefsSourceBundle[] {
  const nowMs = asTime(input.now ?? new Date()) ?? Date.now();
  const windowMs = days(input.discoveryWindowDays ?? DEFAULT_DISCOVERY_WINDOW_DAYS);
  return input.candidateTrees.filter((tree) => {
    if (tree.companyId !== input.companyId || tree.userId !== input.userId) return false;
    assertCompanyScope(tree);
    return isBriefTreeRelevantToUser(tree) && nowMs - lastMeaningfulEventMs(tree) <= windowMs;
  });
}

export function sortBriefCards(cards: BriefCard[]): BriefCard[] {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.lastMeaningfulEventAt).getTime() - new Date(a.lastMeaningfulEventAt).getTime();
  });
}

export function filterExpiredBriefCards(cards: BriefCard[], now: Date | string = new Date()): BriefCard[] {
  const nowMs = asTime(now) ?? Date.now();
  return cards.filter((card) => card.pinned || !card.expiresAt || new Date(card.expiresAt).getTime() > nowMs);
}

export function dedupeBriefCursorEvents(
  events: BriefCursorEvent[],
  previousDedupeState: readonly string[] = [],
): BriefCursorDedupeResult {
  const seen = new Set(previousDedupeState);
  const freshEvents: BriefCursorEvent[] = [];
  for (const event of events) {
    const key = event.fingerprint ?? event.id;
    if (seen.has(key)) continue;
    seen.add(key);
    freshEvents.push(event);
  }
  const sortedState = [...seen].slice(-MAX_DEDUPE_STATE);
  const lastSeen = freshEvents.reduce<number | null>((max, event) => {
    const time = asTime(event.eventAt);
    return time == null ? max : Math.max(max ?? 0, time);
  }, null);
  return {
    freshEvents,
    dedupeState: sortedState,
    lastSeenAt: lastSeen == null ? null : toIso(lastSeen),
  };
}
