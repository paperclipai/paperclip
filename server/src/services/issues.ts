import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  costEvents,
  documentRevisions,
  documents,
  financeEvents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueApprovals,
  issueAttachments,
  issueInboxArchives,
  issueLabels,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  labels,
  linearIssueLinks,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type {
  AcceptedPlanDecomposition,
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
  IssueBlockerAttention,
  IssueBlockedInboxAttention,
  IssueBlockedInboxIssueRef,
  IssueProductivityReview,
  IssueProductivityReviewTrigger,
  IssueRelationIssueSummary,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import {
  clampIssueRequestDepth,
  extractAgentMentionIds,
  extractProjectMentionIds,
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { parseObject } from "../adapters/utils.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { buildInitialIssueMonitorFields, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getRunLogStore } from "./run-log-store.js";
import { getTelemetryClient } from "../telemetry.js";
import { getDefaultCompanyGoal } from "./goals.js";
import { allocateIdentifier, deleteLinearIssueForCompany } from "./identifier-allocator.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";
import { runEvidenceGate, type EvidenceFetchResult } from "./evidence-gate-wiring.js";
import { shouldBlockNarratedDone } from "./done-gate.js";
import { shouldBlockUnreviewableInReview } from "./in-review-gate.js";
import {
  parseIssueGraphLivenessIncidentKey,
  RECOVERY_ORIGIN_KINDS,
} from "./recovery/origins.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./recovery/issue-graph-liveness.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const OPEN_ROUTINE_EXECUTION_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const BLOCKED_PROMOTION_AWAITING_USER_EVENT = "sweep_blocked_promotion_skipped_awaiting_user";
const BLOCKED_PROMOTION_AWAITING_USER_COUNTER = "sweep.blocked_promotion_skipped_awaiting_user";
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_ISSUES_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES = 2_000_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES = 256_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS = 60_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS = 8;

function awaitingUserInputReason(body: string): string | null {
  const normalized = body.toLowerCase();
  const hasExplicitPhrase = [
    "pick a",
    "confirm",
    "let me know",
    "blocked on clarification",
    "blocked awaiting",
    "awaiting user",
    "awaiting your",
  ].some((phrase) => normalized.includes(phrase));
  if (hasExplicitPhrase) return "explicit_phrase";

  const hasQuestion = body.includes("?");
  const hasUserMention = /(^|\s)@[^\s]+|user:\/\//.test(body);
  if (hasQuestion && hasUserMention) return "question_with_user_mention";

  return null;
}

async function findBlockedPromotionAwaitingUserInput(
  dbOrTx: any,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId">,
) {
  const latestAgentComment = await dbOrTx
    .select({
      id: issueComments.id,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        or(
          sql<boolean>`${issueComments.authorAgentId} IS NOT NULL`,
          sql<boolean>`${issueComments.createdByRunId} IS NOT NULL`,
          eq(issueComments.authorType, "agent"),
        )!,
      ),
    )
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(1)
    .then((rows: Array<{ id: string; body: string; createdAt: Date }>) => rows[0] ?? null);

  if (!latestAgentComment) return null;
  const reason = awaitingUserInputReason(latestAgentComment.body);
  if (!reason) return null;

  const userReplyAfterAgentQuestion = await dbOrTx
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
        sql<boolean>`${issueComments.authorUserId} IS NOT NULL`,
        gt(issueComments.createdAt, latestAgentComment.createdAt),
      ),
    )
    .limit(1)
    .then((rows: Array<{ id: string }>) => rows[0] ?? null);

  if (userReplyAfterAgentQuestion) return null;
  return {
    commentId: latestAgentComment.id,
    commentCreatedAt: latestAgentComment.createdAt,
    reason,
  };
}

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function readStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function findOpenRoutineExecutionLockOwnerForIssue(db: Db, companyId: string, issueId: string) {
  const target = await db
    .select({
      id: issues.id,
      originKind: issues.originKind,
      originId: issues.originId,
      originFingerprint: issues.originFingerprint,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!target || target.originKind !== "routine_execution" || !target.originId) return null;

  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "routine_execution"),
        eq(issues.originId, target.originId),
        eq(issues.originFingerprint, target.originFingerprint),
        inArray(issues.status, OPEN_ROUTINE_EXECUTION_ISSUE_STATUSES),
        isNull(issues.hiddenAt),
        isNotNull(issues.executionRunId),
        ne(issues.id, issueId),
      ),
    )
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(
  settings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return {
    environmentId: settings?.environmentId ?? null,
    provisionCommand: settings?.workspaceStrategy?.provisionCommand ?? null,
    teardownCommand: settings?.workspaceStrategy?.teardownCommand ?? null,
    workspaceRuntime: settings?.workspaceRuntime ?? null,
  };
}

function toTimestampMs(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

type IssueCommentRunLogAttributionCandidate = {
  id: string;
  createdAt: Date | string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByRunId?: string | null;
};

type IssueCommentRunLogAttributionRun = {
  runId: string;
  agentId: string;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  logContent: string;
};

export function deriveIssueCommentRunLogAttribution(
  comments: readonly IssueCommentRunLogAttributionCandidate[],
  runs: readonly IssueCommentRunLogAttributionRun[],
) {
  const derivedByCommentId = new Map<string, {
    derivedAuthorAgentId: string;
    derivedCreatedByRunId: string;
    derivedAuthorSource: "run_log_comment_post";
  }>();

  for (const comment of comments) {
    if (comment.authorAgentId || !comment.authorUserId || comment.createdByRunId) continue;
    const commentCreatedAtMs = toTimestampMs(comment.createdAt);
    if (commentCreatedAtMs === null) continue;

    let bestMatch:
      | {
        runId: string;
        agentId: string;
        distanceMs: number;
      }
      | null = null;

    for (const run of runs) {
      const runStartMs = toTimestampMs(run.startedAt ?? run.createdAt);
      const runEndMs = toTimestampMs(run.finishedAt ?? run.createdAt);
      if (runStartMs === null || runEndMs === null) continue;
      if (
        commentCreatedAtMs < runStartMs
        || commentCreatedAtMs > runEndMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS
      ) {
        continue;
      }
      if (!run.logContent.includes(`comment id: ${comment.id}`)) continue;

      const distanceMs = Math.abs(runEndMs - commentCreatedAtMs);
      if (!bestMatch || distanceMs < bestMatch.distanceMs) {
        bestMatch = {
          runId: run.runId,
          agentId: run.agentId,
          distanceMs,
        };
      }
    }

    if (!bestMatch) continue;
    derivedByCommentId.set(comment.id, {
      derivedAuthorAgentId: bestMatch.agentId,
      derivedCreatedByRunId: bestMatch.runId,
      derivedAuthorSource: "run_log_comment_post",
    });
  }

  return derivedByCommentId;
}

export interface IssueFilters {
  attention?: "blocked";
  status?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includePluginOperations?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
type IssuePlanDecompositionRow = typeof issuePlanDecompositions.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueScheduledRetryRow = {
  runId: string;
  status: "scheduled_retry" | "queued" | "running" | "cancelled";
  agentId: string;
  agentName: string | null;
  retryOfRunId: string | null;
  scheduledRetryAt: Date | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryExhaustedReason?: string | null;
  error?: string | null;
  errorCode?: string | null;
};
type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueReadStat = {
  issueId: string;
  myLastReadAt: Date | null;
};
type IssueLastActivityStat = {
  issueId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};

function serializeAcceptedPlanDecomposition(
  decomposition: IssuePlanDecompositionRow,
): AcceptedPlanDecomposition {
  return {
    id: decomposition.id,
    companyId: decomposition.companyId,
    sourceIssueId: decomposition.sourceIssueId,
    acceptedPlanRevisionId: decomposition.acceptedPlanRevisionId,
    acceptedInteractionId: decomposition.acceptedInteractionId,
    status: decomposition.status as AcceptedPlanDecomposition["status"],
    requestFingerprint: decomposition.requestFingerprint,
    // Intentionally omit requestedChildren here; the API only needs stable counts
    // and child ids, while the durable table keeps the full child draft payload.
    requestedChildCount: decomposition.requestedChildCount,
    childIssueIds: normalizeIssuePlanDecompositionChildIds(decomposition.childIssueIds),
    ownerAgentId: decomposition.ownerAgentId,
    ownerUserId: decomposition.ownerUserId,
    ownerRunId: decomposition.ownerRunId,
    completedAt: decomposition.completedAt,
    createdAt: decomposition.createdAt,
    updatedAt: decomposition.updatedAt,
  };
}
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
type IssueCreateInput = Omit<typeof issues.$inferInsert, "companyId"> & {
  labelIds?: string[];
  blockedByIssueIds?: string[];
  inheritExecutionWorkspaceFromIssueId?: string | null;
  /**
   * Mirror-create signal from Linear-side imports (webhook, manual import,
   * bulk-import). Plumbs to allocateIdentifier so the linear-provider path
   * skips IssueCreate and uses this identifier verbatim, and ensures a
   * linear_issue_links row is written for paperclip-provider companies
   * too. Suppresses the compensating Linear-delete on tx rollback — the
   * Linear issue pre-existed.
   */
  linkedLinearIssue?: { id: string; identifier: string };
};
type IssueChildCreateInput = IssueCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type AcceptedPlanDecompositionInput = {
  acceptedPlanRevisionId: string;
  children: IssueChildCreateInput[];
  actorAgentId?: string | null;
  actorUserId?: string | null;
  actorRunId?: string | null;
};
type AcceptedPlanDocumentInteraction = {
  id: string;
};
type IssueRelationSummaryMap = {
  blockedBy: IssueRelationIssueSummary[];
  blocks: IssueRelationIssueSummary[];
};
export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  /** Blockers whose status is `done` but whose execution workspace has not yet finalized. */
  pendingFinalizeBlockerIssueIds: string[];
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
export type ChildIssueCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "error",
  "adapter_failed",
  "cancelled",
  "timed_out",
]);
const STALE_ISSUE_CONTEXT_RUN_STATUSES = ["queued", "scheduled_retry"] as const;
const ISSUE_LIST_DESCRIPTION_MAX_CHARS = 1200;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string | null | undefined, maxChars: number): string | null {
  if (value == null) return null;
  return truncateByCodePoint(value, maxChars);
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateInlineSummary(value: string | null | undefined, maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]` : normalized;
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function normalizeAcceptedPlanDecompositionFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAcceptedPlanDecompositionFingerprintValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeAcceptedPlanDecompositionFingerprintValue(record[key])]),
    );
  }
  return String(value);
}

const ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS = new Set([
  "id",
  "companyId",
  "parentId",
  "identifier",
  "checkoutRunId",
  "executionRunId",
  "executionLockedAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "hiddenAt",
  "createdAt",
  "updatedAt",
  "createdByAgentId",
  "createdByUserId",
  "updatedByAgentId",
  "updatedByUserId",
  "actorAgentId",
  "actorUserId",
]);

function normalizeAcceptedPlanDecompositionFingerprintChild(child: IssueChildCreateInput) {
  return Object.fromEntries(
    Object.entries(child).filter(([key]) => !ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS.has(key)),
  );
}

function createAcceptedPlanDecompositionRequestFingerprint(input: {
  acceptedPlanRevisionId: string;
  children: IssueChildCreateInput[];
}) {
  const canonical = JSON.stringify(normalizeAcceptedPlanDecompositionFingerprintValue({
    acceptedPlanRevisionId: input.acceptedPlanRevisionId,
    children: input.children.map(normalizeAcceptedPlanDecompositionFingerprintChild),
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeIssuePlanDecompositionChildIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function readAcceptedPlanConfirmationTarget(payload: unknown): {
  revisionId: string;
  key: string;
  issueId: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = (payload as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const record = target as Record<string, unknown>;
  if (record.type !== "issue_document") return null;
  const revisionId = readStringFromRecord(record, "revisionId");
  const key = readStringFromRecord(record, "key");
  const issueId = readStringFromRecord(record, "issueId");
  if (!revisionId || !key || !issueId) return null;
  return { revisionId, key, issueId };
}

async function resolveAcceptedPlanClaimOwner(input: {
  dbOrTx: Pick<Db, "select">;
  claim: Pick<typeof issuePlanDecompositions.$inferSelect, "ownerAgentId" | "ownerUserId" | "ownerRunId">;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  actorRunId?: string | null;
}) {
  const nextOwner = {
    ownerAgentId: input.actorAgentId ?? null,
    ownerUserId: input.actorUserId ?? null,
    ownerRunId: input.actorRunId ?? null,
  };
  if (
    input.claim.ownerAgentId === nextOwner.ownerAgentId
    && input.claim.ownerUserId === nextOwner.ownerUserId
    && input.claim.ownerRunId === nextOwner.ownerRunId
  ) {
    return nextOwner;
  }

  if (!input.claim.ownerRunId) {
    return nextOwner;
  }

  const existingOwnerRun = await input.dbOrTx
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.claim.ownerRunId))
    .then((rows) => rows[0] ?? null);
  if (existingOwnerRun && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(existingOwnerRun.status)) {
    return {
      ownerAgentId: input.claim.ownerAgentId,
      ownerUserId: input.claim.ownerUserId,
      ownerRunId: input.claim.ownerRunId,
    };
  }

  return nextOwner;
}

async function findAcceptedPlanDocumentInteraction(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    sourceIssueId: string;
    acceptedPlanRevisionId: string;
  },
): Promise<AcceptedPlanDocumentInteraction | null> {
  const rows = await dbOrTx
    .select({
      id: issueThreadInteractions.id,
      payload: issueThreadInteractions.payload,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.sourceIssueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));

  for (const row of rows) {
    const target = readAcceptedPlanConfirmationTarget(row.payload);
    if (
      target?.issueId === input.sourceIssueId &&
      target.key === "plan" &&
      target.revisionId === input.acceptedPlanRevisionId
    ) {
      return { id: row.id };
    }
  }
  return null;
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

/**
 * Returns the set of execution-workspace ids whose most recent workspace operation
 * is NOT a successful `workspace_finalize`. These workspaces have either an in-flight
 * run, a failed finalize, or never reached the finalize barrier — dependents that
 * read this workspace must wait until finalize succeeds.
 *
 * Workspaces with no recorded operations are considered finalized (nothing has
 * touched them since they were realized).
 */
export async function listUnfinalizedExecutionWorkspaceIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceIds: string[],
): Promise<Set<string>> {
  const unfinalized = new Set<string>();
  if (executionWorkspaceIds.length === 0) return unfinalized;

  // Pull every workspace op for the candidate workspaces and pick the latest per
  // workspace in memory. Per-workspace LATERAL queries would be tighter, but the
  // candidate set is tiny in practice (one workspace per blocker per readiness call).
  const rows = await dbOrTx
    .select({
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
      ),
    );

  const latestByWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    const current = latestByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const workspaceId of executionWorkspaceIds) {
    const latest = latestByWorkspace.get(workspaceId);
    if (!latest) continue; // no ops recorded → treat as finalized
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    unfinalized.add(workspaceId);
  }

  return unfinalized;
}

async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of uniqueIssueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }
  if (uniqueIssueIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.status,
      blockerExecutionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    );

  // Collect executionWorkspaceIds of "done" blockers — these are the only ones
  // subject to the workspace-finalize barrier. Blockers that aren't done already
  // mark the dependent as not-ready and don't need a finalize check.
  const doneBlockerWorkspaceIds = new Set<string>();
  for (const row of blockerRows) {
    if (row.blockerStatus === "done" && row.blockerExecutionWorkspaceId) {
      doneBlockerWorkspaceIds.add(row.blockerExecutionWorkspaceId);
    }
  }
  const unfinalizedWorkspaceIds = await listUnfinalizedExecutionWorkspaceIds(
    dbOrTx,
    companyId,
    [...doneBlockerWorkspaceIds],
  );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.issueId) ?? createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    } else if (
      row.blockerExecutionWorkspaceId &&
      unfinalizedWorkspaceIds.has(row.blockerExecutionWorkspaceId)
    ) {
      // Workspace-finalize barrier: the blocker's most recent run on its
      // execution workspace hasn't recorded a successful workspace_finalize.
      // Treat the dependent as not-ready until sync-back lands (or the run
      // finalizes); a subsequent finalize wake will re-evaluate readiness.
      // `allBlockersDone` is cleared too so that callers using it as a
      // proxy for "this dependent can proceed" still see the gate.
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.pendingFinalizeBlockerIssueIds.push(row.blockerIssueId);
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(issues.status, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

async function getWorkspaceInheritanceIssue(
  db: DbReader,
  companyId: string,
  issueId: string,
) {
  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    throw notFound("Workspace inheritance issue not found");
  }
  return issue;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

// NOTE: A previous helper `issueLastActivityAtExpr(companyId, userId)` lived
// here that computed a per-user, per-row "last activity" expression via
// correlated subqueries on issue_comments / issue_read_states. It was the
// right-hand side of `inboxVisibleForUserCondition`, which made that predicate
// non-sargable and caused the inbox query to take 1-2 minutes for accounts
// with a few thousand issues. It has been replaced by the materialized
// `issues.last_activity_at` column maintained by DB triggers (see migration
// 0072_issues_last_activity_at.sql).

const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

function issueLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
    )
  `;
}

function issueLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'issue'
        AND ${activityLog.entityId} = ${issues.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function issueCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = issueLatestCommentAtExpr(companyId);
  const latestLogAt = issueLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${issues.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

/**
 * Hide issues that the given user has archived from their inbox, unless new
 * activity has occurred on the issue since the archive timestamp.
 *
 * The right-hand side compares against the materialized
 * {@link issues.lastActivityAt} column rather than a per-row dynamic
 * expression involving correlated subqueries over `issue_comments`,
 * `issue_read_states`, and `activity_log`. That makes the predicate sargable
 * and lets Postgres perform a single hash semi-join against
 * `issue_inbox_archives` instead of replaying multiple correlated subqueries
 * per scanned issue.
 *
 * Semantic note: this uses a global "last activity on the issue" timestamp,
 * not a per-user "subjective" activity timestamp (which is what the previous
 * implementation computed). Concretely: if user U archives issue X at T1 and
 * then *user U themselves* posts a comment at T2 > T1, the issue will resurface
 * (under the old implementation it would not, because U's own comment was
 * counted as "their own touch" and excluded). This matches Slack/Linear inbox
 * semantics and is the desired behavior.
 */
function inboxVisibleForUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issues.lastActivityAt}
    )
  `;
}

const LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS = [
  "plugin:paperclipai.content-machine:case",
  "plugin:paperclipai.content-machine:evaluation",
  "plugin:paperclipai.content-machine:source-sync",
] as const;

function nonPluginOperationIssueCondition() {
  return sql<boolean>`NOT (
    ${issues.originKind} LIKE 'plugin:%:operation'
    OR ${issues.originKind} LIKE 'plugin:%:operation:%'
    OR ${inArray(issues.originKind, LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS)}
  )`;
}

function shouldIncludePluginOperationIssues(filters: IssueFilters | undefined) {
  return Boolean(
    filters?.includePluginOperations ||
    filters?.originKind ||
    filters?.originKindPrefix ||
    filters?.originId ||
    filters?.projectId,
  );
}

/** Named entities commonly emitted in saved issue bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Checks if a comment body contains a plain-text @mention of a multi-word agent name. */
function containsPlainTextAgentMention(bodyLower: string, agentNameLower: string): boolean {
  const needle = `@${agentNameLower}`;
  let index = bodyLower.indexOf(needle);

  while (index !== -1) {
    const before = index > 0 ? bodyLower[index - 1] : "";
    const afterIndex = index + needle.length;
    const after = afterIndex < bodyLower.length ? bodyLower[afterIndex] : "";

    const startsMention = before === "" || /[^a-z0-9_]/.test(before);
    const endsMentionChars = " \t\n\r,!?;:.)]}>\"'`";
    const endsMention = after === "" || endsMentionChars.includes(after);
    if (startsMention && endsMention) return true;

    index = bodyLower.indexOf(needle, index + 1);
  }

  return false;
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestIssueActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

function issueListOrderBy(
  companyId: string,
  {
    hasSearch,
    priorityOrder,
    searchOrder,
    sortField,
    sortDir,
  }: {
    hasSearch: boolean;
    priorityOrder: SQL;
    searchOrder: SQL;
    sortField?: IssueFilters["sortField"];
    sortDir?: IssueFilters["sortDir"];
  },
) {
  const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
  if (sortField === "updated") {
    const activityOrder = sortDir === "asc"
      ? asc(canonicalLastActivityAt)
      : desc(canonicalLastActivityAt);
    const updatedOrder = sortDir === "asc" ? asc(issues.updatedAt) : desc(issues.updatedAt);
    const idOrder = sortDir === "asc" ? asc(issues.id) : desc(issues.id);
    return hasSearch
      ? [asc(searchOrder), activityOrder, updatedOrder, idOrder]
      : [activityOrder, updatedOrder, idOrder];
  }

  return [
    hasSearch ? asc(searchOrder) : asc(priorityOrder),
    asc(priorityOrder),
    desc(canonicalLastActivityAt),
    desc(issues.updatedAt),
    desc(issues.id),
  ];
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.issueId);
      if (existing) existing.push(row.label);
      else map.set(row.issueId, [row.label]);
    }
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

/**
 * Evidence-gate fetcher (BLO-4824 / BLO-4461). Loads the data the pure
 * evaluator needs: issue labels, the 10 most-recent comments, and any
 * work_products. Caller supplies the description (already on the existing
 * row in the PATCH handler, no need to re-select).
 */
async function fetchEvidenceForIssue(
  dbOrTx: any,
  issueId: string,
  description: string | null,
): Promise<EvidenceFetchResult> {
  const [recentComments, workProductRows, labelsByIssueId] = await Promise.all([
    dbOrTx
      .select({
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt))
      .limit(10),
    dbOrTx
      .select({
        type: issueWorkProducts.type,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId)),
    labelMapForIssues(dbOrTx, [issueId]),
  ]);

  const issueLabels = labelsByIssueId.get(issueId) ?? [];
  return {
    description,
    labels: issueLabels.map((l: { name: string }) => ({ name: l.name })),
    comments: recentComments as EvidenceFetchResult["comments"],
    workProducts: workProductRows as EvidenceFetchResult["workProducts"],
  };
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"];
const BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES = ["pending"];
const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND = "harness_liveness_escalation";
const PRODUCTIVITY_REVIEW_ORIGIN_KIND = "issue_productivity_review";
// Excluded from the "all children terminal?" check that gates parent wakes:
// these originKinds are system-generated by the harness itself (productivity
// reviews, liveness escalations, stranded-issue recoveries, stale active-run
// evaluations). Counting them as work-children causes false-positive parent
// wakes — see PCL-2418.
const SYSTEM_HARNESS_CHILD_ORIGIN_KINDS: string[] = [
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND,
  "stranded_issue_recovery",
  "stale_active_run_evaluation",
];
const PRODUCTIVITY_REVIEW_TERMINAL_STATUSES = ["done", "cancelled"];
const PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS = [
  "issue.productivity_review_created",
  "issue.productivity_review_updated",
];
const PRODUCTIVITY_REVIEW_TRIGGERS: readonly IssueProductivityReviewTrigger[] = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
];
const BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES = ["done", "cancelled"];
const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

type IssueBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  executionRunId?: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};
type IssueBlockerAttentionInputNode =
  Pick<
    IssueBlockerAttentionNode,
    "id" | "companyId" | "parentId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId"
  >
  & { executionRunId?: string | null };

type IssueBlockerAttentionEdge = {
  issueId: string;
  blockerIssueId: string;
};
type IssueBlockerAttentionQueryRow = IssueBlockerAttentionNode & {
  issueId: string | null;
  blockerIssueId: string;
};
type IssueBlockerAttentionActivePathRow = {
  issueId: string | null;
};
type IssueBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  for (const runIdChunk of chunkList([...new Set(runIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIdChunk),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

    for (const row of rows) {
      map.set(row.id, row);
    }
  }
  return map;
}

function createIssueBlockerAttention(input: Partial<IssueBlockerAttention> = {}): IssueBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(node: IssueBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? node?.id ?? null;
}

function appendBlockerAttentionEdges(
  edgesByIssueId: Map<string, IssueBlockerAttentionEdge[]>,
  rows: IssueBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByIssueId.get(row.issueId) ?? [];
    if (!existing.some((edge) => edge.blockerIssueId === row.blockerIssueId)) {
      existing.push(row);
      edgesByIssueId.set(row.issueId, existing);
    }
  }
}

type IssueRelationSummaryRow = {
  relatedId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function summarizeIssueRelationRow(row: IssueRelationSummaryRow): IssueRelationIssueSummary {
  return {
    id: row.relatedId,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueRelationIssueSummary["status"],
    priority: row.priority as IssueRelationIssueSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: IssueRelationIssueSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, IssueRelationIssueSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, IssueRelationIssueSummary>();
  const edgesByIssueId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByIssueId.get(row.currentIssueId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByIssueId.set(row.currentIssueId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeIssueRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (issueId: string, seen: Set<string>): IssueRelationIssueSummary[] => {
    if (seen.has(issueId)) return [];
    const node = nodesById.get(issueId);
    if (!node || node.status === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(issueId);
    const downstreamIds = edgesByIssueId.get(issueId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, IssueRelationIssueSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(rootId, [...deduped.values()].sort((a, b) => a.title.localeCompare(b.title)));
    }
  }

  return terminalByRoot;
}

function readProductivityReviewTrigger(value: unknown): IssueProductivityReviewTrigger | null {
  if (typeof value !== "string") return null;
  return PRODUCTIVITY_REVIEW_TRIGGERS.includes(value as IssueProductivityReviewTrigger)
    ? (value as IssueProductivityReviewTrigger)
    : null;
}

function readProductivityReviewStreak(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

async function listIssueProductivityReviewMap(
  dbOrTx: any,
  companyId: string,
  sourceIssueIds: string[],
): Promise<Map<string, IssueProductivityReview>> {
  const map = new Map<string, IssueProductivityReview>();
  if (sourceIssueIds.length === 0) return map;

  const reviewRows: Array<{
    sourceIssueId: string | null;
    reviewIssueId: string;
    reviewIdentifier: string | null;
    status: string;
    priority: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  for (const chunk of chunkList([...new Set(sourceIssueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        sourceIssueId: issues.originId,
        reviewIssueId: issues.id,
        reviewIdentifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          inArray(issues.originId, chunk),
          isNull(issues.hiddenAt),
          notInArray(issues.status, PRODUCTIVITY_REVIEW_TERMINAL_STATUSES),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id));
    reviewRows.push(...rows);
  }

  if (reviewRows.length === 0) return map;

  const reviewIssueIds = reviewRows.map((row) => row.reviewIssueId);
  const triggerByReviewIssueId = new Map<
    string,
    { trigger: IssueProductivityReviewTrigger | null; noCommentStreak: number | null }
  >();
  for (const chunk of chunkList(reviewIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const detailRows = await dbOrTx
      .select({
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, chunk),
          inArray(activityLog.action, PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS),
        ),
      )
      .orderBy(desc(activityLog.createdAt));
    for (const row of detailRows as Array<{
      entityId: string;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }>) {
      if (triggerByReviewIssueId.has(row.entityId)) continue;
      triggerByReviewIssueId.set(row.entityId, {
        trigger: readProductivityReviewTrigger(row.details?.trigger),
        noCommentStreak: readProductivityReviewStreak(row.details?.noCommentStreak),
      });
    }
  }

  for (const row of reviewRows) {
    if (!row.sourceIssueId) continue;
    if (map.has(row.sourceIssueId)) continue;
    const detail = triggerByReviewIssueId.get(row.reviewIssueId);
    map.set(row.sourceIssueId, {
      reviewIssueId: row.reviewIssueId,
      reviewIdentifier: row.reviewIdentifier,
      status: row.status as IssueProductivityReview["status"],
      priority: row.priority as IssueProductivityReview["priority"],
      trigger: detail?.trigger ?? null,
      noCommentStreak: detail?.noCommentStreak ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return map;
}

async function listIssueBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: IssueBlockerAttentionInputNode[],
): Promise<Map<string, IssueBlockerAttention>> {
  const roots = issueRows.filter((row) => row.companyId === companyId && row.status === "blocked");
  const attentionMap = new Map<string, IssueBlockerAttention>();
  for (const row of issueRows) {
    if (row.status !== "blocked") {
      attentionMap.set(row.id, createIssueBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, IssueBlockerAttentionNode>();
  const edgesByIssueId = new Map<string, IssueBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  let frontier = roots.map((root) => root.id);
  let truncated = false;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();

    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );
      const childRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issues.parentId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, chunk),
            ne(issues.status, "done"),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);

      appendBlockerAttentionEdges(edgesByIssueId, [
        ...explicitBlockerRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
        ...childRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.issueId || nodesById.has(row.blockerIssueId)) continue;
        nodesById.set(row.blockerIssueId, {
          id: row.blockerIssueId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          executionRunId: row.executionRunId,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
        });
        nextFrontier.add(row.blockerIssueId);
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) {
      truncated = true;
      break;
    }
    frontier = [...nextFrontier];
  }
  if (frontier.length > 0) truncated = true;

  const nodeIds = [...nodesById.keys()];
  const activeIssueIds = new Set<string>();
  const agentIds = new Set<string>();
  const issueIdByExecutionRunId = new Map<string, string>();
  for (const node of nodesById.values()) {
    if (node.assigneeAgentId) agentIds.add(node.assigneeAgentId);
    if (node.executionRunId) issueIdByExecutionRunId.set(node.executionRunId, node.id);
  }

  for (const chunk of chunkList([...issueIdByExecutionRunId.keys()], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const runRows: Array<{ id: string }> = await dbOrTx
      .select({
        id: heartbeatRuns.id,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES),
          inArray(heartbeatRuns.id, chunk),
        ),
      );

    for (const row of runRows) {
      const issueId = issueIdByExecutionRunId.get(row.id);
      if (issueId) activeIssueIds.add(issueId);
    }
  }

  for (const chunk of chunkList(nodeIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const wakeRowsPromise: Promise<IssueBlockerAttentionActivePathRow[]> = dbOrTx
      .select({
        issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES),
          sql`${agentWakeupRequests.runId} is null`,
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`, chunk),
        ),
      );
    const wakeRows = await wakeRowsPromise;
    for (const row of wakeRows) {
      if (row.issueId) activeIssueIds.add(row.issueId);
    }
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.status !== "done")
    .map((node) => node.id);
  const explicitWaitingIssueIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(explicitWaitCandidateIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const interactionRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
            inArray(issueThreadInteractions.issueId, chunk),
          ),
        );
      for (const row of interactionRows) explicitWaitingIssueIds.add(row.issueId);

      const approvalRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            inArray(issueApprovals.issueId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingIssueIds.add(row.issueId);
    }

    // Recovery rows are intentionally company-wide: a liveness escalation for
    // the same leaf blocker represents an active waiting path even when that
    // blocker is reached through another blocked graph.
    const recoveryRows: Array<{ id: string; originId: string | null }> = await dbOrTx
      .select({ id: issues.id, originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          notInArray(issues.status, BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES),
        ),
      );
    for (const row of recoveryRows) {
      const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
      if (!parsed || parsed.companyId !== companyId) continue;
      explicitWaitingIssueIds.add(row.id);
      explicitWaitingIssueIds.add(parsed.issueId);
      explicitWaitingIssueIds.add(parsed.leafIssueId);
    }

    const recoveryActionRows: Array<{ sourceIssueId: string }> = await dbOrTx
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          inArray(issueRecoveryActions.sourceIssueId, explicitWaitCandidateIds),
        ),
      );
    for (const row of recoveryActionRows) explicitWaitingIssueIds.add(row.sourceIssueId);
  }

  const agentRows: IssueBlockerAttentionAgentRow[] = agentIds.size > 0
    ? await dbOrTx
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])))
    : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (truncated || seen.has(nodeId)) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: sample, sampleStalledBlockerIdentifier: null };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeId, sampleStalledBlockerIdentifier: null };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.status === "done") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (explicitWaitingIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.assigneeUserId && node.status !== "cancelled") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "in_review") {
      const hasWaitingPath = activeIssueIds.has(node.id) || Boolean(node.assigneeUserId);
      if (hasWaitingPath) {
        return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
      return { covered: false, stalled: true, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: nodeSample };
    }
    if (activeIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "cancelled") {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "backlog" && node.assigneeAgentId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }

    const downstream = (edgesByIssueId.get(node.id) ?? []).filter((edge) => nodesById.get(edge.blockerIssueId)?.status !== "done");
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) => classifyPath(edge.blockerIssueId, nextSeen));
      const stalledChild = classified.find((result) => result.stalled || result.sampleStalledBlockerIdentifier);
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.assigneeAgentId) {
      const assignee = agentsById.get(node.assigneeAgentId);
      if (!assignee || assignee.companyId !== companyId || !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(assignee.status)) {
        return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
    }

    return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
  };

  for (const root of roots) {
    const topLevelEdges = (edgesByIssueId.get(root.id) ?? []).filter((edge) => nodesById.get(edge.blockerIssueId)?.status !== "done");
    if (topLevelEdges.length === 0) {
      attentionMap.set(root.id, createIssueBlockerAttention({
        state: "needs_attention",
        reason: "attention_required",
      }));
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerIssueId, new Set([root.id])),
    }));
    const coveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - coveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerIssueId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: IssueBlockerAttention["state"];
    let reason: IssueBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = topLevelEdges.every((edge) => nodesById.get(edge.blockerIssueId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(root.id, createIssueBlockerAttention({
      state,
      reason,
      unresolvedBlockerCount: topLevelEdges.length,
      coveredBlockerCount,
      stalledBlockerCount,
      attentionBlockerCount,
      sampleBlockerIdentifier: sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
      sampleStalledBlockerIdentifier:
        stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
    }));
  }

  return attentionMap;
}

const issueListSelect = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  projectWorkspaceId: issues.projectWorkspaceId,
  goalId: issues.goalId,
  parentId: issues.parentId,
  title: issues.title,
  // Slice the description prefix server-side to bound payload size. Using
  // `substring(text, 1, n)` (not `convert_to(...)+substring`) is what makes
  // this fast on TOAST'd rows: PG can fetch only the first ~n*encoding-max
  // bytes via heap_tuple_untoast_attr_slice and decompress just enough pglz
  // chunks to satisfy them. The earlier convert_to-based approach forced a
  // full detoast on every list row (eBPF profile showed pglz_decompress at
  // ~14% of pg CPU under list load with 66% of issues > 2KB description).
  description: sql<string | null>`substring(${issues.description}, 1, ${ISSUE_LIST_DESCRIPTION_MAX_CHARS})`,
  status: issues.status,
  workMode: issues.workMode,
  priority: issues.priority,
  estimate: issues.estimate,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  checkoutRunId: issues.checkoutRunId,
  executionRunId: issues.executionRunId,
  executionAgentNameKey: issues.executionAgentNameKey,
  executionLockedAt: issues.executionLockedAt,
  createdByAgentId: issues.createdByAgentId,
  createdByUserId: issues.createdByUserId,
  issueNumber: issues.issueNumber,
  identifier: issues.identifier,
  legacyIdentifier: issues.legacyIdentifier,
  originKind: issues.originKind,
  originId: issues.originId,
  originRunId: issues.originRunId,
  originFingerprint: issues.originFingerprint,
  requestDepth: issues.requestDepth,
  billingCode: issues.billingCode,
  assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  monitorNextCheckAt: issues.monitorNextCheckAt,
  monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
  monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
  monitorAttemptCount: issues.monitorAttemptCount,
  monitorNotes: issues.monitorNotes,
  monitorScheduledBy: issues.monitorScheduledBy,
  executionWorkspaceId: issues.executionWorkspaceId,
  executionWorkspacePreference: issues.executionWorkspacePreference,
  executionWorkspaceSettings: sql<null>`null`,
  startedAt: issues.startedAt,
  completedAt: issues.completedAt,
  cancelledAt: issues.cancelledAt,
  hiddenAt: issues.hiddenAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  lastActivityAt: issues.lastActivityAt,
  // Evidence-gate verdict (BLO-4824). Returned but typically not rendered
  // in the list view — useful for sorting/filtering issues that have a
  // recorded verdict.
  lastEvidenceVerdict: issues.lastEvidenceVerdict,
};

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

async function userCommentStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueUserCommentStats[]> {
  const stats: IssueUserCommentStats[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueComments.issueId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${issueComments.authorUserId} = ${userId} THEN ${issueComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${userId}
              THEN ${issueComments.createdAt}
            END
          )
        `,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
        ),
      )
      .groupBy(issueComments.issueId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueReadStat[]> {
  const stats: IssueReadStat[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueReadStates.issueId,
        myLastReadAt: issueReadStates.lastReadAt,
      })
      .from(issueReadStates)
      .where(
        and(
          eq(issueReadStates.companyId, companyId),
          eq(issueReadStates.userId, userId),
          inArray(issueReadStates.issueId, issueIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<IssueLastActivityStat[]> {
  const byIssueId = new Map<string, IssueLastActivityStat>();
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIdChunk),
          ),
        )
        .groupBy(issueComments.issueId),
      dbOrTx
        .select({
          issueId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, issueIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byIssueId.set(row.issueId, {
        issueId: row.issueId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byIssueId.get(row.issueId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byIssueId.set(row.issueId, {
          issueId: row.issueId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byIssueId.values()];
}

async function blockedByMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const map = new Map<string, IssueRelationIssueSummary[]>();
  const uniqueIssueIds = [...new Set(issueIds)];
  if (uniqueIssueIds.length === 0) return map;

  for (const issueId of uniqueIssueIds) {
    map.set(issueId, []);
  }

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentIssueId: issueRelations.relatedIssueId,
        relatedId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentIssueId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueRelationIssueSummary["status"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => a.title.localeCompare(b.title));
  }

  return map;
}

export const EXECUTIVE_AGENT_ROLES_FOR_HOLDS = new Set(["ceo", "cto"]);

const EXECUTIVE_HOLD_MARKER_REGEX =
  /do\s+not\s+retry\s+before\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?(?:\s+(?:UTC|GMT))?)/i;

export function parseExecutiveHoldMarkerTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed) ? new Date(trimmed) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const looseMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(?:UTC|GMT)?$/i,
  );
  if (looseMatch) {
    const time = looseMatch[2].length === 5 ? `${looseMatch[2]}:00` : looseMatch[2];
    const date = new Date(`${looseMatch[1]}T${time}Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

export function extractExecutiveHoldMarker(body: string | null | undefined): Date | null {
  if (!body) return null;
  const match = body.match(EXECUTIVE_HOLD_MARKER_REGEX);
  if (!match) return null;
  return parseExecutiveHoldMarkerTimestamp(match[1]);
}

export function findActiveExecutiveHold(
  comments: Array<{
    id: string;
    body: string | null;
    createdAt: Date;
    authorRole: string | null;
  }>,
  now: Date = new Date(),
): { until: Date; commentId: string } | null {
  const sorted = [...comments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const comment of sorted) {
    if (!comment.authorRole || !EXECUTIVE_AGENT_ROLES_FOR_HOLDS.has(comment.authorRole)) continue;
    const until = extractExecutiveHoldMarker(comment.body);
    if (!until) continue;
    return until.getTime() > now.getTime()
      ? { until, commentId: comment.id }
      : null;
  }
  return null;
}

const BLOCKED_INBOX_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const BLOCKED_INBOX_ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const BLOCKED_INBOX_ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const BLOCKED_INBOX_PENDING_INTERACTION_STATUSES = ["pending"] as const;
const BLOCKED_INBOX_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS = [
  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
  RECOVERY_ORIGIN_KINDS.issueProductivityReview,
  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
] as const;
const BLOCKED_INBOX_SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

type BlockedInboxIssueRow = IssueRow & { labels?: IssueLabelRow[]; labelIds?: string[] };
type BlockedInboxInteractionRow = {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
};
type BlockedInboxApprovalRow = {
  approvalId: string;
  issueId: string;
  createdAt: Date;
};

function issueRef(row: Pick<IssueRow, "id" | "identifier" | "title" | "status" | "priority" | "assigneeAgentId" | "assigneeUserId"> | null | undefined): IssueBlockedInboxIssueRef | null {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueBlockedInboxIssueRef["status"],
    priority: row.priority as IssueBlockedInboxIssueRef["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attentionBase(input: {
  state: IssueBlockedInboxAttention["state"];
  reason: IssueBlockedInboxAttention["reason"];
  severity: IssueBlockedInboxAttention["severity"];
  stoppedSinceAt: Date | string | null | undefined;
  owner: IssueBlockedInboxAttention["owner"];
  action: IssueBlockedInboxAttention["action"];
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue?: IssueBlockedInboxIssueRef | null;
  recoveryIssue?: IssueBlockedInboxIssueRef | null;
  approvalId?: string | null;
  interactionId?: string | null;
  sampleIssueIdentifier?: string | null;
  externalDetailsRedacted?: boolean;
}): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason,
    severity: input.severity,
    stoppedSinceAt: isoDate(input.stoppedSinceAt),
    owner: input.owner,
    action: input.action,
    sourceIssue: input.sourceIssue,
    leafIssue: input.leafIssue ?? null,
    recoveryIssue: input.recoveryIssue ?? null,
    approvalId: input.approvalId ?? null,
    interactionId: input.interactionId ?? null,
    sampleIssueIdentifier:
      input.sampleIssueIdentifier
      ?? input.leafIssue?.identifier
      ?? input.recoveryIssue?.identifier
      ?? input.sourceIssue?.identifier
      ?? null,
    redaction: {
      externalDetailsRedacted: input.externalDetailsRedacted ?? false,
      secretFieldsOmitted: true,
    },
  };
}

function readSuccessfulRunHandoffFromActivity(row: {
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): SuccessfulRunHandoffState | null {
  const details = row.details ?? {};
  const state =
    row.action === "issue.successful_run_handoff_required"
      ? "required"
      : row.action === "issue.successful_run_handoff_resolved"
        ? "resolved"
        : row.action === "issue.successful_run_handoff_escalated"
          ? "escalated"
          : null;
  if (!state) return null;

  const detectedProgressSummary =
    readStringFromRecord(details, "detectedProgressSummary")
    ?? readStringFromRecord(details, "detected_progress_summary")
    ?? null;

  return {
    state,
    required: state === "required",
    sourceRunId:
      readStringFromRecord(details, "sourceRunId")
      ?? readStringFromRecord(details, "source_run_id")
      ?? readStringFromRecord(details, "resumeFromRunId")
      ?? row.runId
      ?? null,
    correctiveRunId:
      readStringFromRecord(details, "correctiveRunId")
      ?? readStringFromRecord(details, "corrective_run_id")
      ?? (state !== "required" ? row.runId : null),
    assigneeAgentId:
      readStringFromRecord(details, "assigneeAgentId")
      ?? readStringFromRecord(details, "agentId")
      ?? row.agentId
      ?? null,
    detectedProgressSummary: detectedProgressSummary ? redactSensitiveText(detectedProgressSummary) : null,
    createdAt: row.createdAt,
  };
}

async function listSuccessfulRunHandoffMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, SuccessfulRunHandoffState>> {
  const uniqueIssueIds = [...new Set(issueIds)];
  const states = new Map<string, SuccessfulRunHandoffState>();
  if (uniqueIssueIds.length === 0) return states;

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        entityId: activityLog.entityId,
        action: activityLog.action,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, issueIdChunk),
        inArray(activityLog.action, [...BLOCKED_INBOX_SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
      ))
      .orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id));

    for (const row of rows as Array<{
      entityId: string;
      action: string;
      agentId: string | null;
      runId: string | null;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }>) {
      if (states.has(row.entityId)) continue;
      const state = readSuccessfulRunHandoffFromActivity(row);
      if (state) states.set(row.entityId, state);
    }
  }

  return states;
}

function externalWaitFromDescription(description: string | null): { owner: string; action: string } | null {
  if (!description) return null;
  const owner = description.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExternalWaitDescription(
  description: string | null | undefined,
  external: { owner: string; action: string } | null,
) {
  if (!description) return null;
  let redacted = description
    .split(/\r?\n/)
    .filter((line) => !/^\s*external\s+(?:owner|action)\s*:/i.test(line))
    .join("\n");

  for (const value of [external?.owner, external?.action]) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[redacted external wait detail]");
  }

  redacted = redacted.replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > 0 ? redacted : null;
}

function blockedInboxResponseDescription(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  if (!attention.redaction.externalDetailsRedacted) return row.description;
  return redactExternalWaitDescription(row.description, externalWaitFromDescription(row.description));
}

function blockedInboxSearchText(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  return [
    row.identifier,
    row.title,
    blockedInboxResponseDescription(attention, row),
    attention.sourceIssue?.identifier,
    attention.sourceIssue?.title,
    attention.leafIssue?.identifier,
    attention.leafIssue?.title,
    attention.recoveryIssue?.identifier,
    attention.recoveryIssue?.title,
    attention.action.label,
    attention.action.detail,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function blockedInboxSeverityRank(severity: IssueBlockedInboxAttention["severity"]) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function issuePriorityRank(priority: string) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function compareBlockedInboxRows(
  left: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
  right: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
) {
  const leftAttention = left.blockedInboxAttention;
  const rightAttention = right.blockedInboxAttention;
  const severity = blockedInboxSeverityRank(leftAttention.severity)
    - blockedInboxSeverityRank(rightAttention.severity);
  if (severity !== 0) return severity;

  const leftStopped = leftAttention.stoppedSinceAt
    ? new Date(leftAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rightStopped = rightAttention.stoppedSinceAt
    ? new Date(rightAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftStopped !== rightStopped) return leftStopped - rightStopped;

  const priority = issuePriorityRank(left.priority) - issuePriorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftActivity = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : new Date(left.updatedAt).getTime();
  const rightActivity = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : new Date(right.updatedAt).getTime();
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  return right.id.localeCompare(left.id);
}

async function listIssueBlockedInboxAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: BlockedInboxIssueRow[],
): Promise<Map<string, IssueBlockedInboxAttention>> {
  const rowIssueIds = [...new Set(issueRows.map((row) => row.id))];
  const result = new Map<string, IssueBlockedInboxAttention>();
  if (rowIssueIds.length === 0) return result;

  const [graphIssueRows, graphRelationRows, companyAgentRows] = await Promise.all([
    dbOrTx
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        notInArray(issues.status, [...BLOCKED_INBOX_TERMINAL_STATUSES]),
      )),
    dbOrTx
      .select({
        companyId: issueRelations.companyId,
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
    dbOrTx
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
  ]);

  const graphIssues = graphIssueRows as IssueRow[];
  const graphRelations = graphRelationRows as Array<{ companyId: string; blockerIssueId: string; blockedIssueId: string }>;
  const companyAgents = companyAgentRows as Array<{
    id: string;
    companyId: string;
    name: string;
    role: string;
    title: string | null;
    status: string;
    reportsTo: string | null;
  }>;
  const graphIssueIds = graphIssues.map((issue) => issue.id);
  const issuesById = new Map<string, IssueRow>(graphIssues.map((issue) => [issue.id, issue]));

  const [activeRunRows, wakeRows, scheduledRetryRows, interactionRows, approvalRows, handoffMap] = await Promise.all([
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: heartbeatRuns.companyId,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...BLOCKED_INBOX_ACTIVE_RUN_STATUSES]),
            inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: agentWakeupRequests.companyId,
            issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
            agentId: agentWakeupRequests.agentId,
            status: agentWakeupRequests.status,
          })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, companyId),
            inArray(agentWakeupRequests.status, [...BLOCKED_INBOX_ACTIVE_WAKE_STATUSES]),
            sql`${agentWakeupRequests.runId} is null`,
            inArray(sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: heartbeatRuns.companyId,
            issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            kind: issueThreadInteractions.kind,
            createdAt: issueThreadInteractions.createdAt,
          })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.status, [...BLOCKED_INBOX_PENDING_INTERACTION_STATUSES]),
            inArray(issueThreadInteractions.issueId, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            approvalId: approvals.id,
            issueId: issueApprovals.issueId,
            createdAt: approvals.createdAt,
          })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(approvals.status, [...BLOCKED_INBOX_PENDING_APPROVAL_STATUSES]),
            inArray(issueApprovals.issueId, graphIssueIds),
          )),
    listSuccessfulRunHandoffMapForIssues(dbOrTx, companyId, rowIssueIds),
  ]);

  const pendingInteractions = (interactionRows as BlockedInboxInteractionRow[]).map((row) => ({
    companyId,
    issueId: row.issueId,
    status: "pending",
  }));
  const pendingApprovals = (approvalRows as BlockedInboxApprovalRow[]).map((row) => ({
    companyId,
    issueId: row.issueId,
    status: "pending",
  }));

  const openRecoveryIssues = graphIssues
    .filter((issue) => BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS.includes(issue.originKind as typeof BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS[number]))
    .flatMap((issue) => {
      const entries = [{ companyId, issueId: issue.id, status: issue.status }];
      if (issue.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(issue.originId);
        if (parsed?.companyId === companyId) {
          entries.push({ companyId, issueId: parsed.issueId, status: issue.status });
          entries.push({ companyId, issueId: parsed.leafIssueId, status: issue.status });
        }
      } else if (
        (issue.originKind === RECOVERY_ORIGIN_KINDS.issueProductivityReview ||
          issue.originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery) && issue.originId
      ) {
        entries.push({ companyId, issueId: issue.originId, status: issue.status });
      }
      return entries;
    });

  const findings = classifyIssueGraphLiveness({
    issues: graphIssues.map((issue) => ({
      id: issue.id,
      companyId: issue.companyId,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId,
      goalId: issue.goalId,
      parentId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      createdByAgentId: issue.createdByAgentId,
      createdByUserId: issue.createdByUserId,
      executionPolicy: issue.executionPolicy,
      executionState: issue.executionState,
      monitorNextCheckAt: issue.monitorNextCheckAt,
      monitorAttemptCount: issue.monitorAttemptCount,
    })),
    relations: graphRelations,
    agents: companyAgents,
    activeRuns: (activeRunRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>)
      .flatMap((row) => row.issueId
        ? [{ companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, status: row.status }]
        : []),
    queuedWakeRequests: [
      ...(wakeRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>),
      ...(scheduledRetryRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>),
    ]
      .flatMap((row) => row.issueId
        ? [{ companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, status: row.status }]
        : []),
    pendingInteractions,
    pendingApprovals,
    openRecoveryIssues,
    now: new Date(),
  });
  const findingByIssueId = new Map<string, IssueLivenessFinding>();
  for (const finding of findings) {
    if (!findingByIssueId.has(finding.issueId)) findingByIssueId.set(finding.issueId, finding);
  }

  const interactionByIssueId = new Map<string, BlockedInboxInteractionRow>();
  for (const row of interactionRows as BlockedInboxInteractionRow[]) {
    if (!interactionByIssueId.has(row.issueId)) interactionByIssueId.set(row.issueId, row);
  }
  const approvalByIssueId = new Map<string, BlockedInboxApprovalRow>();
  for (const row of approvalRows as BlockedInboxApprovalRow[]) {
    if (!approvalByIssueId.has(row.issueId)) approvalByIssueId.set(row.issueId, row);
  }

  for (const row of issueRows) {
    if (row.companyId !== companyId || BLOCKED_INBOX_TERMINAL_STATUSES.includes(row.status as typeof BLOCKED_INBOX_TERMINAL_STATUSES[number]) || row.hiddenAt) {
      continue;
    }
    const source = issueRef(row);
    const handoff = handoffMap.get(row.id);
    if (handoff && (handoff.required || handoff.state === "escalated")) {
      result.set(row.id, attentionBase({
        state: "missing_disposition",
        reason: "missing_successful_run_disposition",
        severity: "high",
        stoppedSinceAt: handoff.createdAt ?? row.updatedAt,
        owner: {
          type: row.assigneeAgentId ? "agent" : row.assigneeUserId ? "user" : "unknown",
          agentId: row.assigneeAgentId,
          userId: row.assigneeUserId,
          label: null,
        },
        action: {
          label: "Choose disposition",
          detail: "Choose exactly one final disposition: done, cancelled, review/input, blocked with owner, delegated follow-up, or queued continuation.",
        },
        sourceIssue: source,
      }));
      continue;
    }

    if (BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS.includes(row.originKind as typeof BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS[number])) {
      let sourceIssue: IssueBlockedInboxIssueRef | null = null;
      let leafIssue: IssueBlockedInboxIssueRef | null = null;
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (parsed?.companyId === companyId) {
          sourceIssue = issueRef(issuesById.get(parsed.issueId));
          leafIssue = issueRef(issuesById.get(parsed.leafIssueId));
        }
      } else if (
        (row.originKind === RECOVERY_ORIGIN_KINDS.issueProductivityReview ||
          row.originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery) && row.originId
      ) {
        sourceIssue = issueRef(issuesById.get(row.originId));
      }
      result.set(row.id, attentionBase({
        state: "recovery_open",
        reason: "open_recovery_issue",
        severity: "high",
        stoppedSinceAt: row.createdAt,
        owner: {
          type: row.assigneeAgentId ? "agent" : row.assigneeUserId ? "user" : "unknown",
          agentId: row.assigneeAgentId,
          userId: row.assigneeUserId,
          label: null,
        },
        action: {
          label: "Resolve recovery",
          detail: "Restore a live path for the source work or record why this recovery issue is a false positive.",
        },
        sourceIssue: sourceIssue ?? source,
        leafIssue,
        recoveryIssue: source,
      }));
      continue;
    }

    const interaction = interactionByIssueId.get(row.id);
    if (interaction) {
      const isUserQuestion = interaction.kind === "ask_user_questions" && Boolean(row.assigneeUserId);
      result.set(row.id, attentionBase({
        state: "awaiting_decision",
        reason: isUserQuestion ? "pending_user_decision" : "pending_board_decision",
        severity: "medium",
        stoppedSinceAt: interaction.createdAt,
        owner: isUserQuestion
          ? { type: "user", agentId: null, userId: row.assigneeUserId, label: null }
          : { type: "board", agentId: null, userId: null, label: "Board" },
        action: {
          label: isUserQuestion ? "Answer question" : "Answer confirmation",
          detail: "Respond to the pending issue-thread interaction so the assignee has a live next action.",
        },
        sourceIssue: source,
        interactionId: interaction.id,
      }));
      continue;
    }

    const approval = approvalByIssueId.get(row.id);
    if (approval) {
      result.set(row.id, attentionBase({
        state: "awaiting_decision",
        reason: "pending_board_decision",
        severity: "medium",
        stoppedSinceAt: approval.createdAt,
        owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: {
          label: "Decide approval",
          detail: "Approve, reject, or request revision on the linked approval.",
        },
        sourceIssue: source,
        approvalId: approval.approvalId,
      }));
      continue;
    }

    const finding = findingByIssueId.get(row.id);
    if (finding) {
      const leaf = finding.dependencyPath.length > 1
        ? issuesById.get(finding.dependencyPath[finding.dependencyPath.length - 1]!.issueId)
        : issuesById.get(finding.recoveryIssueId);
      const ownerAgentId = finding.state === "blocked_by_unassigned_issue"
        ? null
        : finding.recommendedOwnerAgentId ?? row.assigneeAgentId ?? leaf?.assigneeAgentId ?? null;
      result.set(row.id, attentionBase({
        state: "needs_attention",
        reason: finding.state as IssueBlockedInboxAttention["reason"],
        severity: finding.state === "blocked_by_assigned_backlog_issue"
          || finding.state === "in_review_without_action_path"
          ? "high"
          : finding.severity === "critical" ? "critical" : "high",
        stoppedSinceAt: leaf?.updatedAt ?? row.updatedAt,
        owner: {
          type: ownerAgentId ? "agent" : leaf?.assigneeUserId ? "user" : "unknown",
          agentId: ownerAgentId,
          userId: leaf?.assigneeUserId ?? null,
          label: null,
        },
        action: {
          label: (() => {
            switch (finding.state) {
              case "blocked_by_unassigned_issue":
                return "Assign blocker";
              case "blocked_by_assigned_backlog_issue":
                return "Resume parked blocker";
              case "blocked_by_uninvokable_assignee":
                return "Assign active owner";
              case "blocked_by_cancelled_issue":
                return "Replace blocker";
              case "invalid_review_participant":
                return "Repair review participant";
              case "in_review_without_action_path":
                return "Choose review path";
            }
          })(),
          detail: finding.recommendedAction,
        },
        sourceIssue: source,
        leafIssue: issueRef(leaf),
        recoveryIssue: issueRef(issuesById.get(finding.recoveryIssueId)),
        sampleIssueIdentifier: leaf?.identifier ?? finding.identifier,
      }));
      continue;
    }

    const hasMonitor = Boolean(row.monitorNextCheckAt && row.monitorNextCheckAt.getTime() > Date.now());
    const external = row.status === "blocked" && !hasMonitor ? externalWaitFromDescription(row.description) : null;
    if (external) {
      result.set(row.id, attentionBase({
        state: "external_wait",
        reason: "external_owner_action",
        severity: "medium",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "external", agentId: null, userId: null, label: null },
        action: {
          label: "External owner action",
          detail: null,
        },
        sourceIssue: source,
        externalDetailsRedacted: true,
      }));
      continue;
    }

    const blockerAttention = await listIssueBlockerAttentionMap(dbOrTx, companyId, [row]);
    const blockerState = blockerAttention.get(row.id);
    if (row.status === "blocked" && (blockerState?.state === "needs_attention" || blockerState?.state === "stalled")) {
      result.set(row.id, attentionBase({
        state: "needs_attention",
        reason: "blocked_chain_stalled",
        severity: "high",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "unknown", agentId: null, userId: null, label: null },
        action: {
          label: "Inspect blocker chain",
          detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
        },
        sourceIssue: source,
        sampleIssueIdentifier: blockerState.sampleStalledBlockerIdentifier ?? blockerState.sampleBlockerIdentifier,
      }));
    }
  }

  return result;
}

async function blockedInboxIssueConditions(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
) {
  const conditions = [
    eq(issues.companyId, companyId),
    isNull(issues.hiddenAt),
    notInArray(issues.status, [...BLOCKED_INBOX_TERMINAL_STATUSES]),
  ];
  const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
  const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
  const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
  const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;

  if (filters?.descendantOf) {
    conditions.push(sql<boolean>`
      ${issues.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.parentId} = ${filters.descendantOf}
          UNION
          SELECT ${issues.id}
          FROM ${issues}
          JOIN descendants ON ${issues.parentId} = descendants.id
          WHERE ${issues.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  if (filters?.status) {
    const statuses = filters.status.split(",").map((status) => status.trim()).filter(Boolean);
    if (statuses.length > 0) {
      conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]!) : inArray(issues.status, statuses));
    }
  }
  if (filters?.assigneeAgentId) conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
  if (filters?.participantAgentId) conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
  if (filters?.assigneeUserId) conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
  if (touchedByUserId) conditions.push(touchedByUserCondition(companyId, touchedByUserId));
  if (inboxArchivedByUserId) conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
  if (unreadForUserId) conditions.push(unreadForUserCondition(companyId, unreadForUserId));
  if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
  if (filters?.workspaceId) {
    conditions.push(or(
      eq(issues.executionWorkspaceId, filters.workspaceId),
      eq(issues.projectWorkspaceId, filters.workspaceId),
    )!);
  }
  if (filters?.executionWorkspaceId) conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
  if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
  if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
  if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
  if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
  if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
  if (filters?.labelId) {
    const labeledIssueIds = await dbOrTx
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
    if (labeledIssueIds.length === 0) return { conditions: [sql<boolean>`false`], contextUserId };
    conditions.push(inArray(issues.id, labeledIssueIds.map((row: { issueId: string }) => row.issueId)));
  }
  if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
    conditions.push(ne(issues.originKind, "routine_execution"));
  }

  return { conditions, contextUserId };
}

async function listBlockedInboxIssues(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
): Promise<Array<IssueWithLabelsAndRun & {
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention: IssueBlockedInboxAttention;
  productivityReview?: IssueProductivityReview | null;
  lastActivityAt: Date;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  isUnreadForMe?: boolean;
}>> {
  const { conditions, contextUserId } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);

  const rows = (await dbOrTx
    .select(issueListSelect)
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issueCanonicalLastActivityAtExpr(companyId)), desc(issues.updatedAt), desc(issues.id)))
    .map((row: any) => ({
      ...row,
      description: decodeDatabaseTextPreview(row.description, ISSUE_LIST_DESCRIPTION_MAX_CHARS),
    }));
  const withLabels = await withIssueLabels(dbOrTx, rows);
  const withRuns = withActiveRuns(withLabels, await activeRunMapForIssues(dbOrTx, withLabels));
  if (withRuns.length === 0) return [];

  const issueIds = withRuns.map((row) => row.id);
  const [
    statsRows,
    readRows,
    lastActivityRows,
    blockedByMap,
    blockerAttentionByIssueId,
    productivityReviewByIssueId,
    blockedInboxAttentionByIssueId,
  ] = await Promise.all([
    contextUserId ? userCommentStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    contextUserId ? userReadStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    lastActivityStatsForIssues(dbOrTx, companyId, issueIds),
    blockedByMapForIssues(dbOrTx, companyId, issueIds),
    listIssueBlockerAttentionMap(dbOrTx, companyId, withRuns),
    listIssueProductivityReviewMap(dbOrTx, companyId, issueIds),
    listIssueBlockedInboxAttentionMap(dbOrTx, companyId, withRuns),
  ]);

  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of rows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }
  const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
  const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));
  const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));

  const enriched = withRuns.flatMap((row) => {
    const blockedInboxAttention = blockedInboxAttentionByIssueId.get(row.id);
    if (!blockedInboxAttention) return [];
    if (
      rawSearch
      && !blockedInboxSearchText(blockedInboxAttention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return [];

    const activity = lastActivityByIssueId.get(row.id);
    const lastActivityAt = latestIssueActivityAt(
      row.updatedAt,
      activity?.latestCommentAt ?? null,
      activity?.latestLogAt ?? null,
    ) ?? row.updatedAt;
    return [{
      ...row,
      description: blockedInboxResponseDescription(blockedInboxAttention, row),
      blockedBy: blockedByMap.get(row.id) ?? [],
      lastActivityAt,
      ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
      blockedInboxAttention,
      ...(productivityReviewByIssueId.has(row.id)
        ? { productivityReview: productivityReviewByIssueId.get(row.id) }
        : {}),
      ...(contextUserId
        ? deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          })
        : {}),
    }];
  }).sort(compareBlockedInboxRows);

  const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
    ? Math.max(0, Math.floor(filters.offset))
    : 0;
  const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
    ? Math.max(1, Math.floor(filters.limit))
    : undefined;
  return limit === undefined ? enriched.slice(offset) : enriched.slice(offset, offset + limit);
}

async function countBlockedInboxIssues(dbOrTx: any, companyId: string, filters?: IssueFilters): Promise<number> {
  const { conditions } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);
  const rows = (await dbOrTx
    .select()
    .from(issues)
    .where(and(...conditions))) as IssueRow[];
  if (rows.length === 0) return 0;

  const blockedInboxAttentionByIssueId = await listIssueBlockedInboxAttentionMap(dbOrTx, companyId, rows);
  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const issueIds = rows.map((row) => row.id);
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const commentRows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of commentRows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }

  return rows.reduce((count: number, row: IssueRow) => {
    const attention = blockedInboxAttentionByIssueId.get(row.id);
    if (!attention) return count;
    if (
      rawSearch
      && !blockedInboxSearchText(attention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return count;
    return count + 1;
  }, 0);
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const treeControlSvc = issueTreeControlService(db);

  async function getIssueByUuid(id: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getIssueByIdentifier(identifier: string) {
    const upper = identifier.toUpperCase();
    // Primary lookup against the current `identifier`. This is the hot path —
    // every URL with an identifier in it lands here on every request.
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, upper))
      .then((rows) => rows[0] ?? null);
    if (row) {
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    }
    // Legacy fallback: 0084's BLO→PCL backfill stashed the pre-rename
    // identifier in `legacy_identifier` so old URLs (bookmarks, agent
    // memory, copy-pasted refs in chat) still resolve to the correct
    // row. Returning the row here means the caller transparently lands
    // on the renamed issue. URL-bar upgrade is handled UI-side: when
    // the API returns `identifier='PCL-N'` for a request that used the
    // legacy form, `IssueDetail.tsx`'s identifier-mismatch effect fires
    // a `navigate(replace: true)` that swaps the address bar to the
    // current identifier (same effect that handles UUID-via-URL).
    const legacyRow = await db
      .select()
      .from(issues)
      .where(eq(issues.legacyIdentifier, upper))
      .then((rows) => rows[0] ?? null);
    if (!legacyRow) return null;
    const [enriched] = await withIssueLabels(db, [legacyRow]);
    return enriched;
  }

  async function getCurrentScheduledRetryForIssue(issueId: string, companyId: string): Promise<IssueScheduledRetryRow | null> {
    const row = await db
      .select({
        runId: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(asc(heartbeatRuns.scheduledRetryAt), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return row ? { ...row, status: "scheduled_retry" } : null;
  }

  function deriveIssueCommentAuthorType(comment: {
    authorType?: string | null;
    authorAgentId?: string | null;
    authorUserId?: string | null;
  }): IssueCommentAuthorType {
    const explicit = issueCommentAuthorTypeSchema.safeParse(comment.authorType);
    if (explicit.success) return explicit.data;
    if (comment.authorAgentId) return "agent";
    if (comment.authorUserId) return "user";
    return "system";
  }

  function assertIssueCommentAuthorTypeAllowed(
    actor: { agentId?: string | null; userId?: string | null },
    authorType: IssueCommentAuthorType,
  ) {
    if (actor.agentId && authorType !== "agent") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (actor.userId && authorType !== "user") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (!actor.agentId && !actor.userId && authorType !== "system") {
      throw unprocessable("System comments cannot use user or agent authorType without an author id");
    }
  }

  function redactIssueComment<T extends { body: string; authorType?: string | null; authorAgentId?: string | null; authorUserId?: string | null; presentation?: unknown; metadata?: unknown }>(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    authorType: IssueCommentAuthorType;
    presentation: IssueCommentPresentation | null;
    metadata: IssueCommentMetadata | null;
  } {
    return {
      ...comment,
      authorType: deriveIssueCommentAuthorType(comment),
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
      presentation: issueCommentPresentationSchema.nullable().catch(null).parse(comment.presentation ?? null),
      metadata: issueCommentMetadataSchema.nullable().catch(null).parse(comment.metadata ?? null),
    };
  }

  async function readRunLogText(run: {
    runId?: string | null;
    logStore: string | null;
    logRef: string | null;
    logBytes: number | null;
  }) {
    if (run.logStore !== "local_file" || !run.logRef) return "";
    const logBytes = Number(run.logBytes ?? 0);
    if (!Number.isFinite(logBytes) || logBytes <= 0) return "";

    const store = getRunLogStore();
    let offset = 0;
    let content = "";
    let nextOffset: number | undefined = 0;

    try {
      while (nextOffset !== undefined) {
        const remainingBytes = ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES - Buffer.byteLength(content, "utf8");
        if (remainingBytes <= 0) break;
        const chunk = await store.read(
          { store: "local_file", logRef: run.logRef },
          {
            offset,
            limitBytes: Math.min(ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES, remainingBytes),
          },
        );
        content += chunk.content;
        nextOffset = chunk.nextOffset;
        offset = chunk.nextOffset ?? 0;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        logger.warn(
          { err, runId: run.runId ?? undefined, logRef: run.logRef },
          "missing heartbeat run log while deriving issue comment metadata",
        );
        return content;
      }
      throw err;
    }

    return content;
  }

  async function enrichCommentsWithDerivedAgentAttribution<
    T extends {
      id: string;
      companyId: string;
      issueId: string;
      authorAgentId?: string | null;
      authorUserId?: string | null;
      createdByRunId?: string | null;
      createdAt: Date | string;
    },
  >(comments: readonly T[]) {
    const candidates = comments.filter((comment) =>
      !comment.authorAgentId
      && !!comment.authorUserId
      && !comment.createdByRunId,
    );
    if (candidates.length === 0) return comments;

    const companyId = comments[0]?.companyId ?? null;
    const issueId = comments[0]?.issueId ?? null;
    if (!companyId || !issueId) return comments;

    const minCommentCreatedAtMs = candidates.reduce<number | null>((min, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return min;
      return min === null ? timestamp : Math.min(min, timestamp);
    }, null);
    const maxCommentCreatedAtMs = candidates.reduce<number | null>((max, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return max;
      return max === null ? timestamp : Math.max(max, timestamp);
    }, null);
    if (minCommentCreatedAtMs === null || maxCommentCreatedAtMs === null) return comments;

    const minCommentCreatedAt = new Date(minCommentCreatedAtMs).toISOString();
    const maxCommentCreatedAt = new Date(
      maxCommentCreatedAtMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS,
    ).toISOString();

    const runs = await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        logBytes: heartbeatRuns.logBytes,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            sql`exists (
              select 1
              from ${activityLog}
              where ${activityLog.companyId} = ${companyId}
                and ${activityLog.entityType} = 'issue'
                and ${activityLog.entityId} = ${issueId}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
          sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${minCommentCreatedAt}::timestamptz`,
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${maxCommentCreatedAt}::timestamptz`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (runs.length === 0) return comments;

    const runsWithLogs: Array<(typeof runs)[number] & { logContent: string }> = [];
    for (let index = 0; index < runs.length; index += ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS) {
      const batch = runs.slice(index, index + ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS);
      const batchWithLogs = await Promise.all(batch.map(async (run) => ({
        ...run,
        logContent: await readRunLogText(run),
      })));
      runsWithLogs.push(...batchWithLogs);
    }
    const derivedByCommentId = deriveIssueCommentRunLogAttribution(candidates, runsWithLogs);
    if (derivedByCommentId.size === 0) return comments;

    return comments.map((comment) => {
      const derived = derivedByCommentId.get(comment.id);
      return derived ? { ...comment, ...derived } : comment;
    });
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function isTreeHoldInteractionCheckoutAllowed(
    companyId: string,
    checkoutRunId: string | null,
    _gate: ActiveIssueTreePauseHoldGate,
  ) {
    if (!checkoutRunId) return false;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, checkoutRunId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const issueId = readStringFromRecord(run?.contextSnapshot, "issueId");
    if (!run || !issueId) return false;
    return isVerifiedIssueTreeControlInteractionWake(db, {
      companyId,
      issueId,
      agentId: run.agentId,
      runId: run.id,
      wakeupRequestId: run.wakeupRequestId,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> | null | undefined,
    });
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function getIssueRelationSummaryMap(
    companyId: string,
    issueIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, IssueRelationSummaryMap>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const empty = new Map<string, IssueRelationSummaryMap>();
    for (const issueId of uniqueIssueIds) {
      empty.set(issueId, { blockedBy: [], blocks: [] });
    }
    if (uniqueIssueIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      dbOrTx
        .select({
          currentIssueId: issueRelations.issueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentIssueId)?.blockedBy.push(summarizeIssueRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentIssueId)?.blocks.push(summarizeIssueRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => a.title.localeCompare(b.title));
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) => a.title.localeCompare(b.title));
    }

    return empty;
  }

  async function assertNoBlockingCycles(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerIssueIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerIssueId) ?? [];
      list.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, list);
    }

    for (const blockerIssueId of blockerIssueIds) {
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerIssueId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function syncBlockedByIssueIds(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByIssueIds)];
    if (deduped.some((candidate) => candidate === issueId)) {
      throw unprocessable("Issue cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      const lockedIssueIds = [issueId, ...deduped].sort();
      await dbOrTx.execute(
        sql`SELECT ${issues.id} FROM ${issues}
            WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
            ORDER BY ${issues.id}
            FOR UPDATE`,
      );
      const relatedIssues = await dbOrTx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, deduped)));
      if (relatedIssues.length !== deduped.length) {
        throw unprocessable("Blocked-by issues must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, issueId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(issueRelations).values(
      deduped.map((blockerIssueId) => ({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function isSameAgentRetryOfRun(input: {
    actorRunId: string;
    expectedCheckoutRunId: string;
    actorAgentId: string;
  }) {
    const run = await db
      .select({ agentId: heartbeatRuns.agentId, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.actorRunId))
      .then((rows) => rows[0] ?? null);

    return run?.agentId === input.actorAgentId && run.retryOfRunId === input.expectedCheckoutRunId;
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale && !(await isSameAgentRetryOfRun(input))) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    if (adopted) {
      await cancelStaleIssueContextRuns({
        companyId: adopted.companyId,
        issueId: adopted.id,
        keepRunId: input.actorRunId,
        reason: "Cancelled because the issue checkout was adopted by the current execution run",
        errorCode: "issue_checkout_adopted",
      });
    }

    return adopted;
  }

  async function adoptUnownedCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          or(isNull(issues.executionRunId), eq(issues.executionRunId, input.actorRunId)),
        ),
      )
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    if (adopted) {
      await cancelStaleIssueContextRuns({
        companyId: adopted.companyId,
        issueId: adopted.id,
        keepRunId: input.actorRunId,
        reason: "Cancelled because the issue checkout was adopted by the current execution run",
        errorCode: "issue_checkout_adopted",
      });
    }

    return adopted;
  }

  async function clearExecutionRunIfTerminal(issueId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const issue = await tx
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.executionRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.executionRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.executionRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      const updated = await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.executionRunId, issue.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  async function clearStaleExecutionLock(issueId: string, expectedExecutionRunId: string) {
    const stale = await isTerminalOrMissingHeartbeatRun(expectedExecutionRunId);
    if (!stale) return false;

    const cleared = await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.id, issueId),
          eq(issues.executionRunId, expectedExecutionRunId),
        ),
      )
      .returning({ id: issues.id })
      .then((rows) => rows[0] ?? null);

    return cleared != null;
  }

  async function cancelStaleIssueContextRuns(input: {
    companyId: string;
    issueId: string;
    keepRunId?: string | null;
    reason: string;
    errorCode: string;
  }) {
    const now = new Date();
    const conditions: SQL[] = [
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, STALE_ISSUE_CONTEXT_RUN_STATUSES),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
    ];
    if (input.keepRunId) {
      conditions.push(ne(heartbeatRuns.id, input.keepRunId));
    }

    const cancelled = await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: input.reason,
        errorCode: input.errorCode,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      });

    const wakeupRequestIds = cancelled
      .map((run) => run.wakeupRequestId)
      .filter((id): id is string => Boolean(id));
    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({
          status: "skipped",
          finishedAt: now,
          error: input.reason,
          updatedAt: now,
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    return cancelled.length;
  }

  return {
    clearExecutionRunIfTerminal,

    list: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return listBlockedInboxIssues(db, companyId, {
          ...filters,
          includeBlockedBy: true,
          includeBlockedInboxAttention: true,
        });
      }

      const conditions = [eq(issues.companyId, companyId)];
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : undefined;
      const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
        ? Math.max(0, Math.floor(filters.offset))
        : 0;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const includeBlockedInboxAttention = filters?.includeBlockedInboxAttention === true;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${issues.id}
              FROM ${issues}
              JOIN descendants ON ${issues.parentId} = descendants.id
              WHERE ${issues.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(issues.executionWorkspaceId, filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (!shouldIncludePluginOperationIssues(filters)) {
        conditions.push(nonPluginOperationIssueCondition());
      }
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(ne(issues.originKind, "routine_execution"));
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${descriptionContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const baseQuery = db
        .select(issueListSelect)
        .from(issues)
        .where(and(...conditions))
        .orderBy(...issueListOrderBy(companyId, {
          hasSearch,
          priorityOrder,
          searchOrder,
          sortField: filters?.sortField,
          sortDir: filters?.sortDir,
        }));
      const pageQuery = offset > 0
        ? (limit === undefined ? baseQuery.offset(offset) : baseQuery.limit(limit).offset(offset))
        : (limit === undefined ? baseQuery : baseQuery.limit(limit));
      const rows = await pageQuery;
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows, blockedByMap] = await Promise.all([
        contextUserId
          ? userCommentStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        lastActivityStatsForIssues(db, companyId, issueIds),
        includeBlockedBy
          ? blockedByMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, IssueRelationIssueSummary[]>()),
      ]);
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));
      const [
        blockerAttentionByIssueId,
        productivityReviewByIssueId,
        blockedInboxAttentionByIssueId,
      ] = await Promise.all([
        listIssueBlockerAttentionMap(db, companyId, withRuns),
        listIssueProductivityReviewMap(db, companyId, issueIds),
        includeBlockedInboxAttention
          ? listIssueBlockedInboxAttentionMap(db, companyId, withRuns)
          : Promise.resolve(new Map<string, IssueBlockedInboxAttention>()),
      ]);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByIssueId.get(row.id);
          const lastActivityAt = latestIssueActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
            ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
            ...(productivityReviewByIssueId.has(row.id)
              ? { productivityReview: productivityReviewByIssueId.get(row.id) }
              : {}),
          };
        });
      }

      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByIssueId.get(row.id);
        const lastActivityAt = latestIssueActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
          ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
          ...(productivityReviewByIssueId.has(row.id)
            ? { productivityReview: productivityReviewByIssueId.get(row.id) }
            : {}),
          ...deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    count: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return countBlockedInboxIssues(db, companyId, filters);
      }

      const conditions = [eq(issues.companyId, companyId), isNull(issues.hiddenAt)];
      if (filters?.status) {
        const statuses = filters.status.split(",").map((status) => status.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(issues.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      if (filters?.assigneeUserId) conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(issues.executionWorkspaceId, filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        nonPluginOperationIssueCondition(),
        unreadForUserCondition(companyId, userId),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, issueId: string, userId: string) => {
      const deleted = await db
        .delete(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.issueId, issueId),
            eq(issueReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (companyId: string, issueId: string, userId: string, archivedAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      const identifier = normalizeIssueReferenceIdentifier(id);
      if (identifier) {
        return getIssueByIdentifier(identifier);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
    },

    /**
     * Find a paperclip issue by its Linear-side issue id via the
     * `linear_issue_links` table. Used by the Linear plugin's webhook
     * create handler to detect mirrors written by the host's allocator
     * path (`originKind != 'plugin:paperclip-plugin-linear'` parents
     * with linker rows). Without this lookup, the plugin's own dedup
     * (originKind+originId, plugin_state IssueLink) misses host-allocator
     * mirrors and creates duplicates — closing the post-cutover loop.
     *
     * Scoped to (companyId, linearIssueId) — matches the allocator-write
     * path's row shape. Returns null when no link exists.
     */
    getByLinearIssueId: async (companyId: string, linearIssueId: string) => {
      const link = await db
        .select({ paperclipIssueId: linearIssueLinks.paperclipIssueId })
        .from(linearIssueLinks)
        .where(
          and(
            eq(linearIssueLinks.companyId, companyId),
            eq(linearIssueLinks.linearIssueId, linearIssueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!link) return null;
      const issue = await getIssueByUuid(link.paperclipIssueId);
      if (!issue) {
        // Skew: link row points to a paperclip_issue_id that no longer
        // resolves. The FK is ON DELETE CASCADE so this should be
        // unreachable under normal operation; surface as console.error
        // so a pg_dump-restore mishap or out-of-band hard-delete is
        // caught instead of silently masquerading as "no link" — which
        // would make the caller (Linear plugin webhook handler) fall
        // through to mint path and re-open the loop.
        console.error(
          `[issues.getByLinearIssueId] linear_issue_links row for ` +
            `companyId=${companyId} linearIssueId=${linearIssueId} ` +
            `points to missing issues.id=${link.paperclipIssueId}; ` +
            `returning null but this is a data-integrity skew that ` +
            `should not be reachable through normal operations.`,
        );
      }
      return issue;
    },

    linkLinearIssue: async (
      companyId: string,
      input: { issueId: string; linearIssueId: string; linearIdentifier: string },
    ) => {
      const issue = await getIssueByUuid(input.issueId);
      if (!issue || issue.companyId !== companyId) {
        throw notFound("Issue not found");
      }

      const matchingRows = await db
        .select({
          id: linearIssueLinks.id,
          companyId: linearIssueLinks.companyId,
          paperclipIssueId: linearIssueLinks.paperclipIssueId,
          linearIssueId: linearIssueLinks.linearIssueId,
          linearIdentifier: linearIssueLinks.linearIdentifier,
        })
        .from(linearIssueLinks)
        .where(
          or(
            eq(linearIssueLinks.paperclipIssueId, input.issueId),
            and(
              eq(linearIssueLinks.companyId, companyId),
              eq(linearIssueLinks.linearIssueId, input.linearIssueId),
            ),
            and(
              eq(linearIssueLinks.companyId, companyId),
              eq(linearIssueLinks.linearIdentifier, input.linearIdentifier),
            ),
          ),
        );

      const conflicts = matchingRows.filter((row) =>
        row.companyId !== companyId
        || row.paperclipIssueId !== input.issueId
        || row.linearIssueId !== input.linearIssueId
        || row.linearIdentifier !== input.linearIdentifier
      );
      if (conflicts.length > 0) {
        throw conflict("Linear issue link conflict", {
          issueId: input.issueId,
          linearIssueId: input.linearIssueId,
          linearIdentifier: input.linearIdentifier,
          conflicts,
        });
      }

      const existing = matchingRows[0];
      if (existing) {
        await db
          .update(linearIssueLinks)
          .set({ updatedAt: new Date() })
          .where(eq(linearIssueLinks.id, existing.id));
        return;
      }

      try {
        await db.insert(linearIssueLinks).values({
          companyId,
          paperclipIssueId: input.issueId,
          linearIssueId: input.linearIssueId,
          linearIdentifier: input.linearIdentifier,
        });
      } catch (err) {
        const maybe = err as { code?: string; constraint?: string; constraint_name?: string };
        if (maybe.code === "23505") {
          throw conflict("Linear issue link conflict", {
            issueId: input.issueId,
            linearIssueId: input.linearIssueId,
            linearIdentifier: input.linearIdentifier,
            constraint: maybe.constraint ?? maybe.constraint_name,
          });
        }
        throw err;
      }
    },

    getCurrentScheduledRetry: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      return getCurrentScheduledRetryForIssue(issue.id, issue.companyId);
    },

    getRelationSummaries: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const relations = await getIssueRelationSummaryMap(issue.companyId, [issueId], db);
      return relations.get(issueId) ?? { blockedBy: [], blocks: [] };
    },

    getDependencyReadiness: async (issueId: string, dbOrTx: any = db) => {
      const issue = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const readiness = await listIssueDependencyReadinessMap(dbOrTx, issue.companyId, [issueId]);
      return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
    },

    listDependencyReadiness: async (companyId: string, issueIds: string[], dbOrTx: any = db) => {
      return listIssueDependencyReadinessMap(dbOrTx, companyId, issueIds);
    },

    listBlockerAttention: async (
      companyId: string,
      issueRows: IssueBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows);
    },

    listProductivityReviews: async (
      companyId: string,
      sourceIssueIds: string[],
      dbOrTx: any = db,
    ) => {
      return listIssueProductivityReviewMap(dbOrTx, companyId, sourceIssueIds);
    },

    listWakeableBlockedDependents: async (blockerIssueId: string) => {
      const blockerIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, blockerIssueId))
        .then((rows) => rows[0] ?? null);
      if (!blockerIssue) return [];

      const candidates = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.issueId, blockerIssueId),
          ),
        );
      if (candidates.length === 0) return [];

      const wakeableCandidates = candidates.filter(
        (candidate) =>
          candidate.assigneeAgentId && !["backlog", "done", "cancelled"].includes(candidate.status),
      );
      if (wakeableCandidates.length === 0) return [];

      // Defer to the unified readiness check so that a dependent only fires when
      // (a) every blocker is done AND (b) every done blocker's workspace has
      // recorded a successful workspace_finalize. The finalize hook also calls
      // this function on completion, so a wake initially gated by an in-flight
      // sync-back will re-fire once the restore lands locally.
      const readinessMap = await listIssueDependencyReadinessMap(
        db,
        blockerIssue.companyId,
        wakeableCandidates.map((candidate) => candidate.id),
      );

      const withReadiness = wakeableCandidates
        .map((candidate) => {
          const readiness = readinessMap.get(candidate.id) ?? createIssueDependencyReadiness(candidate.id);
          return { candidate, readiness };
        })
        .filter(({ readiness }) => readiness.isDependencyReady && readiness.blockerIssueIds.length > 0);

      const blockedCandidateIds = withReadiness
        .filter(({ candidate }) => candidate.status === "blocked")
        .map(({ candidate }) => candidate.id);

      const suppressedIssueIds = new Set<string>();
      if (blockedCandidateIds.length > 0) {
        const commentRows = await db
          .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
            authorRole: agents.role,
          })
          .from(issueComments)
          .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
          .where(
            and(
              eq(issueComments.companyId, blockerIssue.companyId),
              inArray(issueComments.issueId, blockedCandidateIds),
            ),
          )
          .orderBy(desc(issueComments.createdAt));

        const commentsByIssueId = new Map<string, typeof commentRows>();
        for (const row of commentRows) {
          const list = commentsByIssueId.get(row.issueId) ?? [];
          list.push(row);
          commentsByIssueId.set(row.issueId, list);
        }

        const now = new Date();
        for (const issueId of blockedCandidateIds) {
          const candidateComments = commentsByIssueId.get(issueId) ?? [];
          const hold = findActiveExecutiveHold(candidateComments, now);
          if (hold) {
            suppressedIssueIds.add(issueId);
            logger.debug(
              { issueId, until: hold.until.toISOString(), holdCommentId: hold.commentId },
              `blockers_resolved_sweep: suppressed for issue=${issueId} until=${hold.until.toISOString()} hold_comment=${hold.commentId}`,
            );
          }
        }
      }

      return withReadiness
        .filter(({ candidate }) => !suppressedIssueIds.has(candidate.id))
        .map(({ candidate, readiness }) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: readiness.blockerIssueIds,
        }));
    },

    // Sweep companion to listWakeableBlockedDependents. The latter only fires
    // at the moment a blocker transitions to `done` (`routes/issues.ts` becameDone
    // edge); if that wake is lost (process restart, blocker completed before the
    // dependent existed, etc.) the dependent stays silently stuck with zero wakes
    // targeting it. This sweep finds all eligible dependents whose every blocker
    // is already `done`, so a periodic reconciler can re-fire wakes for them.
    //
    // Cancelled blockers intentionally remain unresolved (see `listIssueDependencyReadinessMap`).
    listResolvedBlockerDependentsToSweep: async (
      companyId: string | undefined,
      opts: { limit?: number; minBlockerResolvedAge?: { milliseconds: number } } = {},
    ) => {
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
      const minAgeMs = Math.max(0, opts.minBlockerResolvedAge?.milliseconds ?? 0);

      const candidateConditions = [
        isNotNull(issues.assigneeAgentId),
        isNull(issues.completedAt),
        isNull(issues.cancelledAt),
        // This is lost-wake recovery for executable work. `in_review` issues
        // already have a reviewer/CI path and should not be polled by agents.
        inArray(issues.status, ["todo", "in_progress", "blocked"]),
      ];
      if (companyId) candidateConditions.push(eq(issues.companyId, companyId));

      const candidates = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issues)
        .where(and(...candidateConditions))
        .limit(limit * 4); // overfetch; many will fail the all-blockers-done predicate

      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((c) => c.id);
      const blockerRows = await db
        .select({
          dependentId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
          blockerCompletedAt: issues.completedAt,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, candidateIds),
          ),
        );

      const byDependent = new Map<
        string,
        { ids: string[]; allDone: boolean; latestResolvedAt: Date | null }
      >();
      for (const row of blockerRows) {
        const entry = byDependent.get(row.dependentId) ?? { ids: [], allDone: true, latestResolvedAt: null };
        entry.ids.push(row.blockerIssueId);
        if (row.blockerStatus !== "done") entry.allDone = false;
        if (row.blockerCompletedAt && (!entry.latestResolvedAt || row.blockerCompletedAt > entry.latestResolvedAt)) {
          entry.latestResolvedAt = row.blockerCompletedAt;
        }
        byDependent.set(row.dependentId, entry);
      }

      const ageCutoff = minAgeMs > 0 ? new Date(Date.now() - minAgeMs) : null;
      const results: Array<{
        id: string;
        companyId: string;
        assigneeAgentId: string;
        blockerIssueIds: string[];
        latestBlockerResolvedAt: Date | null;
      }> = [];
      const candidateStatusById = new Map(candidates.map((c) => [c.id, c.status]));
      for (const candidate of candidates) {
        const blockers = byDependent.get(candidate.id);
        if (!blockers || blockers.ids.length === 0 || !blockers.allDone) continue;
        if (ageCutoff && (!blockers.latestResolvedAt || blockers.latestResolvedAt > ageCutoff)) continue;
        results.push({
          id: candidate.id,
          companyId: candidate.companyId,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: blockers.ids,
          latestBlockerResolvedAt: blockers.latestResolvedAt,
        });
        if (results.length >= limit) break;
      }

      const resultIds = results.map((r) => r.id);
      if (resultIds.length === 0) return results;

      // Explicit waiting paths (request_confirmation/chooser interactions and
      // linked approvals) are already a live action path. The blocker-resolved
      // sweep is a lost-wake recovery path; it must not re-wake executor agents
      // that are parked waiting for a human or reviewer decision.
      const explicitlyWaitingIssueIds = new Set<string>();
      const pendingInteractionRows = await db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            inArray(issueThreadInteractions.issueId, resultIds),
            inArray(issueThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
          ),
        );
      for (const row of pendingInteractionRows) explicitlyWaitingIssueIds.add(row.issueId);

      const pendingApprovalRows = await db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            inArray(issueApprovals.issueId, resultIds),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
          ),
        );
      for (const row of pendingApprovalRows) explicitlyWaitingIssueIds.add(row.issueId);

      const resultsAfterExplicitWaitingSuppression = explicitlyWaitingIssueIds.size === 0
        ? results
        : results.filter((r) => {
            const suppress = explicitlyWaitingIssueIds.has(r.id);
            if (suppress) {
              logger.debug(
                { issueId: r.id },
                "blockers_resolved_sweep: suppressed because issue has an explicit pending interaction or approval",
              );
            }
            return !suppress;
          });

      // BLO-3496: companion suppression to listWakeableBlockedDependents. The
      // edge-triggered path checks executive `do not retry before <ts>` markers
      // before waking; the sweep must too, otherwise a CTO hold gets bypassed
      // every time the periodic reconciler runs and fires the wake again.
      const blockedResultIds = resultsAfterExplicitWaitingSuppression
        .filter((r) => candidateStatusById.get(r.id) === "blocked")
        .map((r) => r.id);
      if (blockedResultIds.length === 0) return resultsAfterExplicitWaitingSuppression;

      const pendingConfirmationRows = await db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(and(
          inArray(issueThreadInteractions.issueId, blockedResultIds),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ));
      const suppressedIssueIds = new Set<string>(pendingConfirmationRows.map((row) => row.issueId));

      const commentRows = await db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
          authorRole: agents.role,
        })
        .from(issueComments)
        .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
        .where(inArray(issueComments.issueId, blockedResultIds))
        .orderBy(desc(issueComments.createdAt));

      const commentsByIssueId = new Map<string, typeof commentRows>();
      for (const row of commentRows) {
        const list = commentsByIssueId.get(row.issueId) ?? [];
        list.push(row);
        commentsByIssueId.set(row.issueId, list);
      }

      const now = new Date();
      for (const issueId of blockedResultIds) {
        const candidateComments = commentsByIssueId.get(issueId) ?? [];
        const hold = findActiveExecutiveHold(candidateComments, now);
        if (hold) {
          suppressedIssueIds.add(issueId);
          logger.debug(
            { issueId, until: hold.until.toISOString(), holdCommentId: hold.commentId },
            `blockers_resolved_sweep: suppressed for issue=${issueId} until=${hold.until.toISOString()} hold_comment=${hold.commentId}`,
          );
        }
      }
      return suppressedIssueIds.size === 0
        ? resultsAfterExplicitWaitingSuppression
        : resultsAfterExplicitWaitingSuppression.filter((r) => !suppressedIssueIds.has(r.id));
    },

    getWakeableParentAfterChildCompletion: async (parentIssueId: string) => {
      const parent = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent || !parent.assigneeAgentId || ["backlog", "done", "cancelled"].includes(parent.status)) {
        return null;
      }

      const children = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, parent.companyId),
            eq(issues.parentId, parentIssueId),
            notInArray(issues.originKind, SYSTEM_HARNESS_CHILD_ORIGIN_KINDS),
          ),
        )
        .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
      if (children.length === 0) return null;
      if (!children.every((child) => child.status === "done" || child.status === "cancelled")) {
        return null;
      }

      const childIdsForSummaries = children.slice(0, MAX_CHILD_COMPLETION_SUMMARIES).map((child) => child.id);
      const commentRows = childIdsForSummaries.length > 0
        ? await db
            .select({
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(and(eq(issueComments.companyId, parent.companyId), inArray(issueComments.issueId, childIdsForSummaries)))
            .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        : [];
      const latestCommentByIssueId = new Map<string, string>();
      for (const comment of commentRows) {
        if (!latestCommentByIssueId.has(comment.issueId)) {
          latestCommentByIssueId.set(comment.issueId, comment.body);
        }
      }
      const childIssueSummaries: ChildIssueCompletionSummary[] = children
        .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
        .map((child) => ({
          ...child,
          summary: truncateInlineSummary(latestCommentByIssueId.get(child.id)),
        }));

      return {
        id: parent.id,
        assigneeAgentId: parent.assigneeAgentId,
        childIssueIds: children.map((child) => child.id),
        childIssueSummaries,
        childIssueSummaryTruncated: children.length > childIssueSummaries.length,
      };
    },

    createChild: async (
      parentIssueId: string,
      data: IssueChildCreateInput,
    ) => {
      const parent = await db
        .select()
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent issue not found");

      const [{ childCount }] = await db
        .select({ childCount: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parent.id)));
      if (childCount >= MAX_CHILD_ISSUES_CREATED_BY_HELPER) {
        throw unprocessable(`Parent issue already has the maximum ${MAX_CHILD_ISSUES_CREATED_BY_HELPER} child issues for this helper`);
      }

      const {
        acceptanceCriteria,
        blockParentUntilDone,
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const child = await issueService(db).create(parent.companyId, {
        ...issueData,
        parentId: parent.id,
        projectId: issueData.projectId ?? parent.projectId,
        goalId: issueData.goalId ?? parent.goalId,
        requestDepth: clampIssueRequestDepth(
          Math.max(clampIssueRequestDepth(parent.requestDepth) + 1, issueData.requestDepth ?? 0),
        ),
        description: appendAcceptanceCriteriaToDescription(issueData.description, acceptanceCriteria),
        inheritExecutionWorkspaceFromIssueId: parent.id,
      });

      if (blockParentUntilDone) {
        const existingBlockers = await db
          .select({ blockerIssueId: issueRelations.issueId })
          .from(issueRelations)
          .where(and(eq(issueRelations.companyId, parent.companyId), eq(issueRelations.relatedIssueId, parent.id), eq(issueRelations.type, "blocks")));
        await syncBlockedByIssueIds(
          parent.id,
          parent.companyId,
          [...new Set([...existingBlockers.map((row) => row.blockerIssueId), child.id])],
          { agentId: actorAgentId ?? null, userId: actorUserId ?? null },
        );
      }

      return {
        issue: child,
        parentBlockerAdded: Boolean(blockParentUntilDone),
      };
    },

    decomposeAcceptedPlan: async (
      sourceIssueId: string,
      data: AcceptedPlanDecompositionInput,
    ) => {
      const sourceIssue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
        })
        .from(issues)
        .where(eq(issues.id, sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue) throw notFound("Source issue not found");

      const requestFingerprint = createAcceptedPlanDecompositionRequestFingerprint({
        acceptedPlanRevisionId: data.acceptedPlanRevisionId,
        children: data.children,
      });

      const initialClaim = await db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${sourceIssue.id} for update`);

        const belongsToPlanDocument = await tx
          .select({ revisionId: documentRevisions.id })
          .from(issueDocuments)
          .innerJoin(documentRevisions, eq(issueDocuments.documentId, documentRevisions.documentId))
          .where(and(
            eq(issueDocuments.companyId, sourceIssue.companyId),
            eq(issueDocuments.issueId, sourceIssue.id),
            eq(issueDocuments.key, "plan"),
            eq(documentRevisions.id, data.acceptedPlanRevisionId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!belongsToPlanDocument) {
          throw unprocessable("acceptedPlanRevisionId must belong to the source issue's plan document");
        }

        const acceptedInteraction = await findAcceptedPlanDocumentInteraction(tx, {
          companyId: sourceIssue.companyId,
          sourceIssueId: sourceIssue.id,
          acceptedPlanRevisionId: data.acceptedPlanRevisionId,
        });
        if (!acceptedInteraction) {
          throw unprocessable("acceptedPlanRevisionId must have an accepted plan confirmation");
        }

        const existing = await tx
          .select()
          .from(issuePlanDecompositions)
          .where(and(
            eq(issuePlanDecompositions.companyId, sourceIssue.companyId),
            eq(issuePlanDecompositions.sourceIssueId, sourceIssue.id),
            eq(issuePlanDecompositions.acceptedPlanRevisionId, data.acceptedPlanRevisionId),
          ))
          .then((rows) => rows[0] ?? null);

        const now = new Date();
        if (!existing) {
          const [created] = await tx
            .insert(issuePlanDecompositions)
            .values({
              companyId: sourceIssue.companyId,
              sourceIssueId: sourceIssue.id,
              acceptedPlanRevisionId: data.acceptedPlanRevisionId,
              acceptedInteractionId: acceptedInteraction.id,
              status: "in_flight",
              requestFingerprint,
              requestedChildCount: data.children.length,
              requestedChildren: data.children as unknown as Record<string, unknown>[],
              childIssueIds: [],
              ownerAgentId: data.actorAgentId ?? null,
              ownerUserId: data.actorUserId ?? null,
              ownerRunId: data.actorRunId ?? null,
              updatedAt: now,
            })
            .returning();
          if (!created) throw new Error("Failed to create accepted-plan decomposition claim");
          return created;
        }

        if (existing.requestFingerprint !== requestFingerprint) {
          throw conflict("Accepted-plan decomposition already exists for this revision with a different child set");
        }

        return existing;
      });

      let currentClaim = initialClaim;
      const newlyCreatedIssues: Array<typeof issues.$inferSelect> = [];

      while (true) {
        const step = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select ${issuePlanDecompositions.id}
                from ${issuePlanDecompositions}
                where ${issuePlanDecompositions.id} = ${currentClaim.id}
                for update`,
          );

          const claim = await tx
            .select()
            .from(issuePlanDecompositions)
            .where(eq(issuePlanDecompositions.id, currentClaim.id))
            .then((rows) => rows[0] ?? null);
          if (!claim) throw notFound("Accepted-plan decomposition claim not found");
          if (claim.requestFingerprint !== requestFingerprint) {
            throw conflict("Accepted-plan decomposition already exists for this revision with a different child set");
          }

          const existingChildIssueIds = normalizeIssuePlanDecompositionChildIds(claim.childIssueIds);
          if (claim.status === "completed" || existingChildIssueIds.length >= data.children.length) {
            const nextIds = existingChildIssueIds.slice(0, data.children.length);
            if (claim.status === "completed" && nextIds.length === data.children.length) {
              return {
                claim,
                createdIssue: null,
              };
            }

            const completedAt = claim.completedAt ?? new Date();
            const ownerPatch = await resolveAcceptedPlanClaimOwner({
              dbOrTx: tx,
              claim,
              actorAgentId: data.actorAgentId,
              actorUserId: data.actorUserId,
              actorRunId: data.actorRunId,
            });
            const [completed] = await tx
              .update(issuePlanDecompositions)
              .set({
                status: "completed",
                childIssueIds: nextIds,
                completedAt,
                ...ownerPatch,
                updatedAt: completedAt,
              })
              .where(eq(issuePlanDecompositions.id, claim.id))
              .returning();
            if (!completed) throw new Error("Failed to complete accepted-plan decomposition claim");
            return {
              claim: completed,
              createdIssue: null,
            };
          }

          const nextChildInput = data.children[existingChildIssueIds.length];
          if (!nextChildInput) {
            throw new Error("Accepted-plan decomposition child cursor moved past the requested children");
          }

          const createdChild = await issueService(tx as unknown as Db).createChild(sourceIssue.id, nextChildInput);
          const nextIds = [...existingChildIssueIds, createdChild.issue.id];
          const now = new Date();
          const nextStatus = nextIds.length === data.children.length ? "completed" : "in_flight";
          const ownerPatch = await resolveAcceptedPlanClaimOwner({
            dbOrTx: tx,
            claim,
            actorAgentId: data.actorAgentId,
            actorUserId: data.actorUserId,
            actorRunId: data.actorRunId,
          });
          const [updatedClaim] = await tx
            .update(issuePlanDecompositions)
            .set({
              status: nextStatus,
              childIssueIds: nextIds,
              completedAt: nextStatus === "completed" ? now : null,
              ...ownerPatch,
              updatedAt: now,
            })
            .where(eq(issuePlanDecompositions.id, claim.id))
            .returning();
          if (!updatedClaim) throw new Error("Failed to persist accepted-plan decomposition progress");
          return {
            claim: updatedClaim,
            createdIssue: createdChild.issue,
          };
        });

        currentClaim = step.claim;
        if (step.createdIssue) {
          newlyCreatedIssues.push(step.createdIssue);
        }
        if (step.claim.status === "completed") break;
      }

      const childIssueIds = normalizeIssuePlanDecompositionChildIds(currentClaim.childIssueIds);
      const childIssueRows = childIssueIds.length > 0
        ? await db
            .select()
            .from(issues)
            .where(and(eq(issues.companyId, sourceIssue.companyId), inArray(issues.id, childIssueIds)))
        : [];
      const childIssueMap = new Map(childIssueRows.map((row) => [row.id, row]));
      const orderedChildIssues = childIssueIds
        .map((childIssueId) => childIssueMap.get(childIssueId))
        .filter((row): row is typeof issues.$inferSelect => Boolean(row));

      const decomposition = serializeAcceptedPlanDecomposition(currentClaim);

      return {
        decomposition,
        childIssueIds: decomposition.childIssueIds,
        childIssues: orderedChildIssues,
        newlyCreatedIssues,
      };
    },

    listAcceptedPlanDecompositions: async (sourceIssueId: string) => {
      const sourceIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue) return [];

      const rows = await db
        .select({
          decomposition: issuePlanDecompositions,
          revisionNumber: documentRevisions.revisionNumber,
        })
        .from(issuePlanDecompositions)
        .leftJoin(
          documentRevisions,
          eq(documentRevisions.id, issuePlanDecompositions.acceptedPlanRevisionId),
        )
        .where(and(
          eq(issuePlanDecompositions.companyId, sourceIssue.companyId),
          eq(issuePlanDecompositions.sourceIssueId, sourceIssue.id),
        ))
        .orderBy(desc(issuePlanDecompositions.createdAt));

      if (rows.length === 0) return [];

      const allChildIds = new Set<string>();
      for (const row of rows) {
        for (const childId of normalizeIssuePlanDecompositionChildIds(row.decomposition.childIssueIds)) {
          allChildIds.add(childId);
        }
      }

      const childIssueRows = allChildIds.size > 0
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              priority: issues.priority,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
            })
            .from(issues)
            .where(and(eq(issues.companyId, sourceIssue.companyId), inArray(issues.id, Array.from(allChildIds))))
        : [];
      const childIssueMap = new Map(childIssueRows.map((row) => [row.id, row]));

      return rows.map((row) => {
        const decomposition = serializeAcceptedPlanDecomposition(row.decomposition);
        const childIds = decomposition.childIssueIds;
        return {
          ...decomposition,
          acceptedPlanRevisionNumber: row.revisionNumber ?? null,
          childIssues: childIds
            .map((childId) => childIssueMap.get(childId) ?? null)
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        };
      });
    },

    create: async (
      companyId: string,
      data: IssueCreateInput,
    ) => {
      const {
        labelIds: inputLabelIds,
        blockedByIssueIds,
        inheritExecutionWorkspaceFromIssueId,
        linkedLinearIssue,
        ...issueData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }

      // If the allocator hits Linear during the tx and the tx subsequently
      // fails, the Linear-side issue would otherwise dangle without a
      // paperclip mirror. We capture its id from inside the tx and, on tx
      // rollback, fire a best-effort IssueDelete so the namespaces stay in
      // sync. Cleanup errors are logged-and-swallowed to avoid masking the
      // original failure that triggered the rollback.
      let createdLinearIssueId: string | null = null;
      try {
        return await db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
        const projectGoalId = await getProjectDefaultGoalId(tx, companyId, issueData.projectId);
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        let executionWorkspaceId = issueData.executionWorkspaceId ?? null;
        let executionWorkspacePreference = issueData.executionWorkspacePreference ?? null;
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        const workspaceInheritanceIssueId = inheritExecutionWorkspaceFromIssueId ?? issueData.parentId ?? null;
        const hasExplicitExecutionWorkspaceOverride =
          issueData.executionWorkspaceId !== undefined ||
          issueData.executionWorkspacePreference !== undefined ||
          issueData.executionWorkspaceSettings !== undefined;
        if (workspaceInheritanceIssueId) {
          const workspaceSource = await getWorkspaceInheritanceIssue(tx, companyId, workspaceInheritanceIssueId);
          if (projectWorkspaceId == null && workspaceSource.projectWorkspaceId) {
            projectWorkspaceId = workspaceSource.projectWorkspaceId;
          }
          if (
            isolatedWorkspacesEnabled &&
            !hasExplicitExecutionWorkspaceOverride &&
            workspaceSource.executionWorkspaceId
          ) {
            const sourceWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                mode: executionWorkspaces.mode,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, workspaceSource.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
            if (sourceWorkspace) {
              executionWorkspaceId = sourceWorkspace.id;
              executionWorkspacePreference = "reuse_existing";
              executionWorkspaceSettings = {
                ...((workspaceSource.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
                mode: issueExecutionWorkspaceModeForPersistedWorkspace(sourceWorkspace.mode),
              };
            }
          }
        }
        // Cache the project policy lookup for this insert. Both the
        // default-settings block and the assignee-environment-promotion block
        // need the same row; without caching they'd issue two round-trips.
        let projectPolicyCached: ReturnType<typeof parseProjectExecutionWorkspacePolicy> | null = null;
        let projectPolicyLoaded = false;
        const loadProjectPolicyOnce = async () => {
          if (projectPolicyLoaded) return projectPolicyCached;
          projectPolicyLoaded = true;
          if (!issueData.projectId) return null;
          const projectRow = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          projectPolicyCached = parseProjectExecutionWorkspacePolicy(projectRow?.executionWorkspacePolicy);
          return projectPolicyCached;
        };

        if (
          executionWorkspaceSettings == null &&
          executionWorkspaceId == null &&
          issueData.projectId
        ) {
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                await loadProjectPolicyOnce(),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        if (data.assigneeAgentId && isolatedWorkspacesEnabled) {
          const currentWorkspaceSettings = executionWorkspaceSettings == null
            ? {}
            : parseObject(executionWorkspaceSettings);
          const issueHasEnvironmentSelection =
            Object.prototype.hasOwnProperty.call(currentWorkspaceSettings, "environmentId");
          // Don't promote the assignee agent's defaultEnvironmentId if either
          // the issue or the project policy already specifies an environment.
          // resolveExecutionWorkspaceEnvironmentId treats issue settings as
          // higher priority than project policy, so promoting the agent's
          // default to issue settings would invert the documented priority
          // (project policy must win over agent default when explicitly set).
          let projectHasEnvironmentSelection = false;
          if (!issueHasEnvironmentSelection && issueData.projectId) {
            const projectPolicy = await loadProjectPolicyOnce();
            projectHasEnvironmentSelection = projectPolicy?.environmentId !== undefined;
          }
          if (!issueHasEnvironmentSelection && !projectHasEnvironmentSelection) {
            const assigneeAgent = await tx
              .select({ defaultEnvironmentId: agents.defaultEnvironmentId })
              .from(agents)
              .where(and(eq(agents.id, data.assigneeAgentId), eq(agents.companyId, companyId)))
              .then((rows) => rows[0] ?? null);
            if (typeof assigneeAgent?.defaultEnvironmentId === "string" && assigneeAgent.defaultEnvironmentId.length > 0) {
              executionWorkspaceSettings = {
                ...currentWorkspaceSettings,
                environmentId: assigneeAgent.defaultEnvironmentId,
              };
            }
          }
        }
        if (!projectWorkspaceId && issueData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.companyId, companyId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        if (projectWorkspaceId) {
          await assertValidProjectWorkspace(companyId, issueData.projectId, projectWorkspaceId, tx);
        }
        if (executionWorkspaceId) {
          await assertValidExecutionWorkspace(companyId, issueData.projectId, executionWorkspaceId, tx);
        }
        // Identifier minting is delegated to allocateIdentifier(), which
        // dispatches on companies.identifier_provider. The paperclip-internal
        // path runs inside this same tx (atomic counter + insert); the
        // Linear path (Task 2.2 of the linear-id-unification plan) will hit
        // Linear's GraphQL before the issues insert, taking the identifier
        // back out-of-tx. For now every company stays on paperclip-source,
        // so behaviour is unchanged from before this refactor.
        const allocation = await allocateIdentifier({
          db: tx,
          companyId,
          title: issueData.title,
          description: issueData.description,
          linkedLinearIssue,
        });
        // Capture the Linear-side issue id as soon as allocation returns so
        // the outer compensating-delete handler can fire even if the issues
        // insert below throws (FK violation, status invariant, etc.).
        // Gated on createdLinearSideIssue: if the caller passed
        // linkedLinearIssue, the Linear issue pre-existed and a tx
        // rollback must NOT delete it. Paperclip-source allocations leave
        // externalIssueId undefined and are skipped here too.
        if (allocation.createdLinearSideIssue && allocation.externalIssueId) {
          createdLinearIssueId = allocation.externalIssueId;
        }
        const issueNumber = allocation.issueNumber;
        const identifier = allocation.identifier;

        const values = {
          ...issueData,
          requestDepth: clampIssueRequestDepth(issueData.requestDepth),
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId: issueData.projectId,
            goalId: issueData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
          ...(executionWorkspacePreference ? { executionWorkspacePreference } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }
        Object.assign(
          values,
          buildInitialIssueMonitorFields({
            policy: normalizeIssueExecutionPolicy(issueData.executionPolicy ?? null),
            status: values.status ?? "backlog",
            assigneeAgentId: values.assigneeAgentId ?? null,
            assigneeUserId: values.assigneeUserId ?? null,
          }),
        );

        const [issue] = await tx.insert(issues).values(values).returning();

        // When the identifier was minted by Linear (companies.identifier_provider
        // = 'linear'), persist the link row in the same tx so the paperclip↔Linear
        // mapping is durably committed alongside the issue itself. If the issue
        // insert fails, the linear_issue_links row never appears and the Linear
        // counterpart created via createLinearIssue() becomes a dangling Linear
        // issue (no paperclip mirror). That's an accepted trade-off: at the
        // current write rates the rare error path is preferable to a more
        // complex compensating Linear-delete flow.
        if (allocation.source === "linear" && allocation.externalIssueId) {
          await tx.insert(linearIssueLinks).values({
            companyId,
            paperclipIssueId: issue.id,
            linearIssueId: allocation.externalIssueId,
            linearIdentifier: allocation.identifier,
          });
        } else if (linkedLinearIssue) {
          // Mirror-import into a paperclip-provider company: identifier
          // stays paperclip-internal but we still bind the cross-tracker
          // mapping so Linear-keyed lookups (`WHERE linear_identifier =
          // 'BLO-N'`) find the mirror. Without this branch, plugin sync
          // state would diverge from the host link table.
          await tx.insert(linearIssueLinks).values({
            companyId,
            paperclipIssueId: issue.id,
            linearIssueId: linkedLinearIssue.id,
            linearIdentifier: linkedLinearIssue.identifier,
          });
        }

        if (inputLabelIds) {
          await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            issue.id,
            companyId,
            blockedByIssueIds,
            {
              agentId: issueData.createdByAgentId ?? null,
              userId: issueData.createdByUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
        });
      } catch (err) {
        // tx rolled back. If the allocator already created a Linear issue
        // (linear path), best-effort IssueDelete it so we don't leave a
        // dangling Linear issue with no paperclip counterpart. Swallow
        // cleanup errors — surfacing them would mask the real failure.
        if (createdLinearIssueId) {
          await deleteLinearIssueForCompany(db, companyId, createdLinearIssueId).catch(
            () => {
              // No logger handle here; the call site logs the original err
              // via the route layer. Cleanup failure is a known soft drop.
            },
          );
        }
        throw err;
      }
    },

    update: async (
      id: string,
      data: Partial<typeof issues.$inferInsert> & {
        labelIds?: string[];
        blockedByIssueIds?: string[];
        actorAgentId?: string | null;
        actorUserId?: string | null;
      },
      dbOrTx: any = db,
    ) => {
      const existing = await dbOrTx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByIssueIds,
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const experimental = await instanceSettings.getExperimental();
      const isolatedWorkspacesEnabled = experimental.enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (existing.status === "blocked" && issueData.status === "todo") {
        const awaitingUserInput = await findBlockedPromotionAwaitingUserInput(dbOrTx, existing);
        if (awaitingUserInput) {
          const details = {
            event: BLOCKED_PROMOTION_AWAITING_USER_EVENT,
            counter: BLOCKED_PROMOTION_AWAITING_USER_COUNTER,
            issueId: existing.id,
            commentId: awaitingUserInput.commentId,
            commentCreatedAt: awaitingUserInput.commentCreatedAt.toISOString(),
            reason: awaitingUserInput.reason,
          };
          logger.warn(details, "blocked to todo promotion skipped because latest agent comment awaits user input");
          getTelemetryClient()?.track(BLOCKED_PROMOTION_AWAITING_USER_COUNTER, {
            reason: awaitingUserInput.reason,
          });
          throw conflict("Blocked issue is awaiting user input", details);
        }
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      // Done-execution gate (narrated-completion hardening, instance flag
      // `enableDoneExecutionGate`, default off). Blocks an agent self-marking
      // an issue `done` when no real execution run ever occurred and no
      // pr-link evidence was recorded — the failure mode where agents post
      // "## Done" via the board API without shipping code. Never gates human
      // actors. See server/src/services/done-gate.ts.
      if (
        experimental.enableDoneExecutionGate &&
        shouldBlockNarratedDone({
          fromStatus: existing.status,
          toStatus: issueData.status,
          existingExecutionRunId: existing.executionRunId,
          lastEvidenceVerdict: existing.lastEvidenceVerdict,
          isAgentActor: actorAgentId != null,
        })
      ) {
        throw unprocessable(
          "Issue cannot be marked done without execution evidence (no execution run and no pr-link evidence)",
          { reason: "no_execution_run_and_no_pr_evidence", issueId: id },
        );
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };
      if (issueData.requestDepth !== undefined) {
        patch.requestDepth = clampIssueRequestDepth(issueData.requestDepth);
      }

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (patch.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (patch.status === "in_progress") {
        const unresolvedBlockerIssueIds = blockedByIssueIds !== undefined
          ? await listUnresolvedBlockerIssueIds(dbOrTx, existing.companyId, blockedByIssueIds)
          : (
              await listIssueDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerIssueIds ?? [];
        if (unresolvedBlockerIssueIds.length > 0) {
          throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
        }
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId);
      }
      const nextProjectId = issueData.projectId !== undefined ? issueData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        issueData.projectWorkspaceId !== undefined ? issueData.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        issueData.executionWorkspaceId !== undefined ? issueData.executionWorkspaceId : existing.executionWorkspaceId;
      const nextExecutionWorkspacePreference =
        issueData.executionWorkspacePreference !== undefined
          ? issueData.executionWorkspacePreference
          : existing.executionWorkspacePreference;
      const nextExecutionWorkspaceSettings =
        issueData.executionWorkspaceSettings !== undefined
          ? parseIssueExecutionWorkspaceSettings(issueData.executionWorkspaceSettings)
          : parseIssueExecutionWorkspaceSettings(existing.executionWorkspaceSettings);
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.companyId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.companyId, nextProjectId, nextExecutionWorkspaceId);
      }

      applyStatusSideEffects(issueData.status, patch);

      // Phase-1 warn-only evidence gate (BLO-4824 / BLO-4461). Records the
      // gate's verdict but never throws on its own — Phase 2 (BLO-4828) will
      // flip `block` to a 422. Errors during evaluation are swallowed so a
      // misbehaving gate can't break the PATCH; production runs surface
      // them via the warn log.
      //
      // The flag-gated in_review enforcement below intentionally lives
      // OUTSIDE the try/catch: an evaluation failure yields verdict == null
      // (gate fails open), while a successfully-computed non-pass verdict
      // throws without being swallowed.
      if (
        issueData.status === "in_review" &&
        existing.status !== "in_review"
      ) {
        let inReviewVerdict: Awaited<ReturnType<typeof runEvidenceGate>> | null = null;
        try {
          const verdict = await runEvidenceGate(
            (issueId) => fetchEvidenceForIssue(dbOrTx, issueId, existing.description),
            id,
          );
          inReviewVerdict = verdict;
          patch.lastEvidenceVerdict = verdict;
          logger.info(
            {
              issueId: id,
              companyId: existing.companyId,
              verdict: verdict.verdict,
              missing: verdict.missing,
              evidenceFound: verdict.evidenceFound,
              unlabeledFallback: verdict.unlabeledFallback,
            },
            `evidence-gate: ${verdict.verdict} on in_review transition`,
          );
        } catch (err) {
          logger.warn(
            {
              issueId: id,
              err: err instanceof Error ? err.message : String(err),
            },
            "evidence-gate: evaluation failed; proceeding without verdict",
          );
        }

        // In-review evidence gate (narrated-review hardening, instance flag
        // `enableInReviewEvidenceGate`, default off). Blocks an agent
        // flipping an issue to `in_review` when the evidence gate found
        // nothing reviewable — the failure mode where an agent does
        // analysis-only work and narrates in_review with no PR, branch, or
        // commits. Never gates human actors. See
        // server/src/services/in-review-gate.ts.
        if (
          experimental.enableInReviewEvidenceGate &&
          shouldBlockUnreviewableInReview({
            fromStatus: existing.status,
            toStatus: issueData.status,
            isAgentActor: actorAgentId != null,
            verdict: inReviewVerdict,
          })
        ) {
          throw unprocessable(
            "Issue cannot be moved to in_review without reviewable evidence " +
              `(missing: ${inReviewVerdict?.missing.join(", ") || "unknown"})`,
            {
              reason: "in_review_without_reviewable_evidence",
              issueId: id,
              missing: inReviewVerdict?.missing ?? [],
            },
          );
        }
      }

      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        // Fix B: also clear the execution lock when leaving in_progress
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        // Fix B: clear execution lock on reassignment, matching checkoutRunId clear
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const runUpdate = async (tx: any) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
          ),
        ]);

        // Mirror the create() path: when the assignee changes to a non-null
        // agent, default the issue's executionWorkspaceSettings.environmentId
        // to the new agent's defaultEnvironmentId. Skip when:
        //   - this update explicitly sets executionWorkspaceSettings.environmentId
        //     (caller is making a deliberate override; respect it), OR
        //   - the project policy already specifies an environmentId (project
        //     policy must win over agent default per the documented priority
        //     order in resolveExecutionWorkspaceEnvironmentId), OR
        //   - the issue already has an environmentId that was *not* the prior
        //     assignee's default (i.e., the operator set it explicitly in an
        //     earlier update; preserve their choice). When the existing
        //     environmentId matches the prior assignee's default, treat it as
        //     auto-promoted and refresh it to the new assignee's default.
        const assigneeChanged =
          issueData.assigneeAgentId !== undefined &&
          issueData.assigneeAgentId !== null &&
          issueData.assigneeAgentId !== existing.assigneeAgentId;
        const explicitEnvInThisUpdate =
          issueData.executionWorkspaceSettings !== undefined &&
          Object.prototype.hasOwnProperty.call(
            parseObject(issueData.executionWorkspaceSettings),
            "environmentId",
          );
        if (assigneeChanged && isolatedWorkspacesEnabled && !explicitEnvInThisUpdate) {
          let projectHasEnvironmentSelection = false;
          if (nextProjectId) {
            const projectRow = await tx
              .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
              .from(projects)
              .where(and(eq(projects.id, nextProjectId), eq(projects.companyId, existing.companyId)))
              .then((rows: Array<{ executionWorkspacePolicy: unknown }>) => rows[0] ?? null);
            const projectPolicy = parseProjectExecutionWorkspacePolicy(projectRow?.executionWorkspacePolicy);
            projectHasEnvironmentSelection = projectPolicy?.environmentId !== undefined;
          }
          if (!projectHasEnvironmentSelection) {
            const baseSettings = nextExecutionWorkspaceSettings == null
              ? {}
              : parseObject(nextExecutionWorkspaceSettings);
            const existingEnvId = typeof baseSettings.environmentId === "string"
              ? baseSettings.environmentId
              : null;

            // Look up both the prior assignee (to detect auto-promoted env)
            // and the new assignee in a single query.
            type AgentRow = { id: string; defaultEnvironmentId: string | null };
            const agentRows: AgentRow[] = await tx
              .select({ id: agents.id, defaultEnvironmentId: agents.defaultEnvironmentId })
              .from(agents)
              .where(
                and(
                  eq(agents.companyId, existing.companyId),
                  inArray(
                    agents.id,
                    [issueData.assigneeAgentId!, existing.assigneeAgentId].filter(
                      (value): value is string => typeof value === "string",
                    ),
                  ),
                ),
              );

            const newAssignee = agentRows.find((row: AgentRow) => row.id === issueData.assigneeAgentId);
            const previousAssignee = existing.assigneeAgentId
              ? agentRows.find((row: AgentRow) => row.id === existing.assigneeAgentId)
              : null;

            const newDefaultEnvId =
              typeof newAssignee?.defaultEnvironmentId === "string" && newAssignee.defaultEnvironmentId.length > 0
                ? newAssignee.defaultEnvironmentId
                : null;
            const previousDefaultEnvId =
              typeof previousAssignee?.defaultEnvironmentId === "string" && previousAssignee.defaultEnvironmentId.length > 0
                ? previousAssignee.defaultEnvironmentId
                : null;

            const existingEnvWasAutoPromoted =
              existingEnvId === null ||
              (previousDefaultEnvId !== null && existingEnvId === previousDefaultEnvId);

            if (newDefaultEnvId && existingEnvWasAutoPromoted) {
              patch.executionWorkspaceSettings = {
                ...baseSettings,
                environmentId: newDefaultEnvId,
              };
            }
          }
        }

        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          currentProjectGoalId,
          projectId: issueData.projectId,
          goalId: issueData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            updated.id,
            existing.companyId,
            blockedByIssueIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        if (
          issueData.executionWorkspaceSettings !== undefined &&
          nextExecutionWorkspaceId &&
          nextExecutionWorkspacePreference === "reuse_existing"
        ) {
          const workspace = await tx
            .select({
              id: executionWorkspaces.id,
              metadata: executionWorkspaces.metadata,
            })
            .from(executionWorkspaces)
            .where(
              and(
                eq(executionWorkspaces.id, nextExecutionWorkspaceId),
                eq(executionWorkspaces.companyId, existing.companyId),
              ),
            )
            .then((rows: Array<{ id: string; metadata: unknown }>) => rows[0] ?? null);
          if (workspace) {
            await tx
              .update(executionWorkspaces)
              .set({
                metadata: mergeExecutionWorkspaceConfig(
                  (workspace.metadata as Record<string, unknown> | null) ?? null,
                  buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(nextExecutionWorkspaceSettings),
                ),
                updatedAt: new Date(),
              })
              .where(eq(executionWorkspaces.id, workspace.id));
          }
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        if (
          (issueData.status === "done" || issueData.status === "cancelled") &&
          existing.status !== issueData.status &&
          existing.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation
        ) {
          const parsedIncident = parseIssueGraphLivenessIncidentKey(existing.originId);
          if (parsedIncident?.issueId && parsedIncident.companyId === existing.companyId) {
            await tx
              .delete(issueRelations)
              .where(
                and(
                  eq(issueRelations.companyId, existing.companyId),
                  eq(issueRelations.issueId, existing.id),
                  eq(issueRelations.relatedIssueId, parsedIncident.issueId),
                  eq(issueRelations.type, "blocks"),
                ),
              );
          }
        }
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseIssueExecutionWorkspaceSettings(row.executionWorkspaceSettings);
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(issues)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        // Clean up FK references that don't use CASCADE or SET NULL
        await tx.delete(issueComments).where(eq(issueComments.issueId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.issueId, id));
        await tx.delete(issueInboxArchives).where(eq(issueInboxArchives.issueId, id));
        await tx.update(financeEvents).set({ issueId: null }).where(eq(financeEvents.issueId, id));
        await tx.update(costEvents).set({ issueId: null }).where(eq(costEvents.issueId, id));
        await tx.update(issues).set({ parentId: null }).where(eq(issues.parentId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.companyId, agentId);

      const now = new Date();
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issueCompany.companyId, id);
      if (
        activePauseHold &&
        !(await isTreeHoldInteractionCheckoutAllowed(issueCompany.companyId, checkoutRunId, activePauseHold))
      ) {
        throw conflict("Issue checkout blocked by active subtree pause hold", {
          issueId: id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        });
      }

      await clearExecutionRunIfTerminal(id);

      if (checkoutRunId) {
        const routineLockOwner = await findOpenRoutineExecutionLockOwnerForIssue(db, issueCompany.companyId, id);
        if (routineLockOwner) {
          throw conflict("Routine execution already locked by another open issue", {
            issueId: id,
            ownerIssueId: routineLockOwner.id,
            ownerIdentifier: routineLockOwner.identifier,
            ownerExecutionRunId: routineLockOwner.executionRunId,
          });
        }
      }

      const dependencyReadiness = await listIssueDependencyReadinessMap(db, issueCompany.companyId, [id]);
      const unresolvedBlockerIssueIds = dependencyReadiness.get(id)?.unresolvedBlockerIssueIds ?? [];
      if (unresolvedBlockerIssueIds.length > 0) {
        throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
      }

      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, expectedStatuses),
            or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
          if (!row) throw notFound("Issue not found");
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Issue not found");
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      // If an executionRunId is blocking checkout but its run is dead, clear it and retry
      if (
        current.executionRunId &&
        current.executionRunId !== checkoutRunId &&
        (current.assigneeAgentId === agentId || current.assigneeAgentId == null)
      ) {
        const cleared = await clearStaleExecutionLock(id, current.executionRunId);
        if (cleared) {
          const now = new Date();
          const retried = await db
            .update(issues)
            .set({
              assigneeAgentId: agentId,
              assigneeUserId: null,
              checkoutRunId,
              executionRunId: checkoutRunId,
              status: "in_progress",
              startedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(issues.id, id),
                inArray(issues.status, expectedStatuses),
                isNull(issues.executionRunId),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (retried) {
            await cancelStaleIssueContextRuns({
              companyId: retried.companyId,
              issueId: retried.id,
              keepRunId: checkoutRunId,
              reason: "Cancelled because the stale issue execution lock was adopted by the current run",
              errorCode: "issue_execution_lock_adopted",
            });
            const [enriched] = await withIssueLabels(db, [retried]);
            return enriched;
          }
        }
      }

      // in_review is intentionally not claimable via checkout (it is excluded from every
      // caller's expectedStatuses, matching shouldAutoCheckoutIssueForWake). When the caller
      // already owns the issue and there is no active checkout/execution owner, the generic
      // "Issue checkout conflict" 409 is misleading: there is no owner to conflict with. Surface
      // a typed 422 pointing at the review-mutation path instead — the assignee can already
      // PATCH/comment/close their own in_review issue without checkout (BLO-8454).
      if (
        current.status === "in_review" &&
        current.assigneeAgentId === agentId &&
        current.checkoutRunId == null &&
        current.executionRunId == null
      ) {
        throw unprocessable("Issue in review is not checked out", {
          code: "issue_in_review_not_checkoutable",
          issueId: current.id,
          status: current.status,
          assigneeAgentId: current.assigneeAgentId,
          checkoutRunId: current.checkoutRunId,
          executionRunId: current.executionRunId,
          supportedMutationPath:
            "Assignees may update, comment on, or close their own in_review issue directly via " +
            "PATCH /issues/{id} without checkout. To resume active work, PATCH status to in_progress first.",
        });
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === actorRunId)
      ) {
        const adopted = await adoptUnownedCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: null as string | null,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      // Clear stale execution lock from a dead run before giving up
      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.executionRunId &&
        current.executionRunId !== actorRunId
      ) {
        const cleared = await clearStaleExecutionLock(id, current.executionRunId);
        if (cleared) {
          const refreshed = await db
            .update(issues)
            .set({
              checkoutRunId: actorRunId,
              executionRunId: actorRunId,
              executionLockedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(issues.id, id),
                eq(issues.status, "in_progress"),
                eq(issues.assigneeAgentId, actorAgentId),
                isNull(issues.executionRunId),
              ),
            )
            .returning({
              id: issues.id,
              companyId: issues.companyId,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              checkoutRunId: issues.checkoutRunId,
            })
            .then((rows) => rows[0] ?? null);
          if (refreshed) {
            await cancelStaleIssueContextRuns({
              companyId: refreshed.companyId,
              issueId: refreshed.id,
              keepRunId: actorRunId,
              reason: "Cancelled because the stale issue execution lock was adopted by the current run",
              errorCode: "issue_execution_lock_adopted",
            });
            return { ...refreshed, adoptedFromRunId: current.executionRunId };
          }
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      await clearExecutionRunIfTerminal(id);
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        const stale = await isTerminalOrMissingHeartbeatRun(existing.checkoutRunId);
        if (!stale) {
          throw conflict("Only checkout run can release issue", {
            issueId: existing.id,
            assigneeAgentId: existing.assigneeAgentId,
            checkoutRunId: existing.checkoutRunId,
            actorRunId: actorRunId ?? null,
          });
        }
      }

      const updated = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      await cancelStaleIssueContextRuns({
        companyId: updated.companyId,
        issueId: updated.id,
        reason: "Cancelled because the issue was released",
        errorCode: "issue_released",
      });
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${id} for update`,
        );
        const existing = await tx
          .select({
            id: issues.id,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const patch: Partial<typeof issues.$inferInsert> = {
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        };
        if (options.clearAssignee) {
          patch.assigneeAgentId = null;
        }

        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const [enriched] = await withIssueLabels(tx, [updated]);
        return {
          issue: enriched,
          previous: {
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
          },
        };
      });
      if (result) {
        await cancelStaleIssueContextRuns({
          companyId: result.issue.companyId,
          issueId: result.issue.id,
          reason: "Cancelled because the issue was force-released",
          errorCode: "issue_force_released",
        });
      }
      return result;
    },
    forceRelease: async (id: string) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      const patch: Partial<typeof issues.$inferInsert> = {
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
        executionAgentNameKey: null,
        updatedAt: new Date(),
      };
      if (existing.status === "in_progress") {
        patch.status = "todo";
      }

      const updated = await db
        .update(issues)
        .set(patch)
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      await cancelStaleIssueContextRuns({
        companyId: updated.companyId,
        issueId: updated.id,
        reason: "Cancelled because the issue was force-released",
        errorCode: "issue_force_released",
      });
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        conditions.push(
          order === "asc"
            ? or(
                gt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), gt(issueComments.id, anchor.id)),
              )!
            : or(
                lt(issueComments.createdAt, anchor.createdAt),
                and(eq(issueComments.createdAt, anchor.createdAt), lt(issueComments.id, anchor.id)),
              )!,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const enrichedComments = await enrichCommentsWithDerivedAgentAttribution(comments);
      return enrichedComments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: async (commentId: string) => {
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      const [enrichedComment] = await enrichCommentsWithDerivedAgentAttribution([comment]);
      return redactIssueComment(enrichedComment ?? comment, censorUsernameInLogs);
    },

    removeComment: async (commentId: string) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const [comment] = await tx
          .delete(issueComments)
          .where(eq(issueComments.id, commentId))
          .returning();

        if (!comment) return null;

        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(eq(issues.id, comment.issueId));

        return redactIssueComment(comment, currentUserRedactionOptions.enabled);
      });
    },

    addComment: async (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
      options?: {
        authorType?: IssueCommentAuthorType | null;
        presentation?: IssueCommentPresentation | null;
        metadata?: IssueCommentMetadata | null;
        createdAt?: Date | string | null;
      },
    ) => {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const authorType = issueCommentAuthorTypeSchema.parse(
        options?.authorType ?? (actor.agentId ? "agent" : actor.userId ? "user" : "system"),
      );
      assertIssueCommentAuthorTypeAllowed(actor, authorType);
      const presentation = issueCommentPresentationSchema.nullable().parse(options?.presentation ?? null);
      const metadata = issueCommentMetadataSchema.nullable().parse(options?.metadata ?? null);
      const createdAt = options?.createdAt ? new Date(options.createdAt) : null;
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          authorType,
          createdByRunId: actor.runId ?? null,
          body: redactedBody,
          presentation,
          metadata,
          ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      return redactIssueComment(comment, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const normalized = normalizeAgentMentionToken(m[1]);
        if (normalized) tokens.add(normalized.toLowerCase());
      }

      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (tokens.size === 0 && explicitAgentMentionIds.length === 0) return [];
      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.companyId, companyId));
      const bodyLower = body.toLowerCase();
      const resolved = new Set<string>(explicitAgentMentionIds);
      for (const agent of rows) {
        const agentNameLower = agent.name.toLowerCase();
        if (
          tokens.has(agentNameLower) ||
          (agentNameLower.includes(" ") && containsPlainTextAgentMention(bodyLower, agentNameLower))
        ) {
          resolved.add(agent.id);
        }
      }
      return [...resolved];
    },

    findMentionedProjectIds: async (
      issueId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const mentionedIds = new Set<string>();
      for (const source of [issue.title, issue.description ?? ""]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
