import { Buffer } from "node:buffer";
import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueApprovals,
  issueAttachments,
  issueInboxArchives,
  issueLabels,
  issueRecoveryActions,
  issueRelations,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueThreadInteractions,
  issues,
  labels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import type {
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
import { getDefaultCompanyGoal } from "./goals.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";
import {
  parseIssueGraphLivenessIncidentKey,
  RECOVERY_ORIGIN_KINDS,
} from "./recovery/origins.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./recovery/issue-graph-liveness.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_ISSUES_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES = 2_000_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES = 256_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS = 60_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS = 8;
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
  priority?: string;
  hasActiveRecovery?: boolean;
  activeRecoveryActionKind?: string | string[];
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
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
  actorUserId?: string | null;
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

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const ISSUE_LIST_DESCRIPTION_MAX_CHARS = 1200;
const ISSUE_LIST_DESCRIPTION_MAX_BYTES = ISSUE_LIST_DESCRIPTION_MAX_CHARS * 4;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
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

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string | null | undefined, maxChars: number): string | null {
  if (value == null) return null;
  return truncateByCodePoint(Buffer.from(value, "base64").toString("utf8"), maxChars);
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    allBlockersDone: true,
    isDependencyReady: true,
  };
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

function lastExternalCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND (
          ${issueComments.authorUserId} IS NULL
          OR ${issueComments.authorUserId} <> ${userId}
        )
    )
  `;
}

function issueLastActivityAtExpr(companyId: string, userId: string) {
  const lastExternalCommentAt = lastExternalCommentAtExpr(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<Date>`
    GREATEST(
      COALESCE(${lastExternalCommentAt}, to_timestamp(0)),
      CASE
        WHEN ${issues.updatedAt} > COALESCE(${myLastTouchAt}, to_timestamp(0))
        THEN ${issues.updatedAt}
        ELSE to_timestamp(0)
      END
    )
  `;
}

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

function inboxVisibleForUserCondition(companyId: string, userId: string) {
  const issueLastActivityAt = issueLastActivityAtExpr(companyId, userId);
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issueLastActivityAt}
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

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"];
const BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES = ["pending"];
const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND = "harness_liveness_escalation";
const PRODUCTIVITY_REVIEW_ORIGIN_KIND = "issue_productivity_review";
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
  description: sql<string | null>`
    CASE
      WHEN ${issues.description} IS NULL THEN NULL
      ELSE encode(
        substring(
          convert_to(${issues.description}, current_setting('server_encoding'))
          FROM 1 FOR ${ISSUE_LIST_DESCRIPTION_MAX_BYTES}
        ),
        'base64'
      )
    END
  `,
  status: issues.status,
  workMode: issues.workMode,
  priority: issues.priority,
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
  const uniqueIssueIds = [...new Set(iss