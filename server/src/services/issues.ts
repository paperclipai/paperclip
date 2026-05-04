import { Buffer } from "node:buffer";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
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
  IssueBlockerAttention,
  IssueProductivityReview,
  IssueProductivityReviewTrigger,
  IssueRelationIssueSummary,
} from "@paperclipai/shared";
import { clampIssueRequestDepth, extractAgentMentionIds, extractProjectMentionIds, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
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
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";
import { parseIssueGraphLivenessIncidentKey } from "./recovery/origins.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_ISSUES_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
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

export interface IssueFilters {
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
  originId?: string;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includeBlockedBy?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
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
  inheritExecutionWorkspaceFromIssueId?: string | null;
};
type IssueChildCreateInput = IssueCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  actorAgentId?: string | null;
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
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, identifier.toUpperCase()))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
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

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

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
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

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
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

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

  return {
    clearExecutionRunIfTerminal,

    list: async (companyId: string, filters?: IssueFilters) => {
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
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
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
      const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
      const baseQuery = db
        .select(issueListSelect)
        .from(issues)
        .where(and(...conditions))
        .orderBy(
          hasSearch ? asc(searchOrder) : asc(priorityOrder),
          asc(priorityOrder),
          desc(canonicalLastActivityAt),
          desc(issues.updatedAt),
          desc(issues.id),
        );
      const pageQuery = offset > 0
        ? (limit === undefined ? baseQuery.offset(offset) : baseQuery.limit(limit).offset(offset))
        : (limit === undefined ? baseQuery : baseQuery.limit(limit));
      const rows = (await pageQuery).map((row) => ({
        ...row,
        description: decodeDatabaseTextPreview(row.description, ISSUE_LIST_DESCRIPTION_MAX_CHARS),
      }));
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
      const [blockerAttentionByIssueId, productivityReviewByIssueId] = await Promise.all([
        listIssueBlockerAttentionMap(db, companyId, withRuns),
        listIssueProductivityReviewMap(db, companyId, issueIds),
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

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
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
      if (/^[A-Z]+-\d+$/i.test(id)) {
        return getIssueByIdentifier(id);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
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

      const candidateIds = candidates.map((candidate) => candidate.id);
      const blockerRows = await db
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, candidateIds),
          ),
        );

      const blockersByIssueId = new Map<string, Array<{ blockerIssueId: string; blockerStatus: string }>>();
      for (const row of blockerRows) {
        const list = blockersByIssueId.get(row.issueId) ?? [];
        list.push({ blockerIssueId: row.blockerIssueId, blockerStatus: row.blockerStatus });
        blockersByIssueId.set(row.issueId, list);
      }

      return candidates
        .filter((candidate) => candidate.assigneeAgentId && !["backlog", "done", "cancelled"].includes(candidate.status))
        .map((candidate) => {
          const blockers = blockersByIssueId.get(candidate.id) ?? [];
          return {
            ...candidate,
            blockerIssueIds: blockers.map((blocker) => blocker.blockerIssueId),
            allBlockersDone: blockers.length > 0 && blockers.every((blocker) => blocker.blockerStatus === "done"),
          };
        })
        .filter((candidate) => candidate.allBlockersDone)
        .map((candidate) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: candidate.blockerIssueIds,
        }));
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
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parentIssueId)))
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

    create: async (
      companyId: string,
      data: IssueCreateInput,
    ) => {
      const {
        labelIds: inputLabelIds,
        blockedByIssueIds,
        inheritExecutionWorkspaceFromIssueId,
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
      return db.transaction(async (tx) => {
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
        // Self-correcting counter: use MAX(issue_number) + 1 if the counter
        // has drifted below the actual max, preventing identifier collisions.
        const [maxRow] = await tx
          .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
          .from(issues)
          .where(eq(issues.companyId, companyId));
        const currentMax = maxRow?.maxNum ?? 0;

        const [company] = await tx
          .update(companies)
          .set({
            issueCounter: sql`greatest(${companies.issueCounter}, ${currentMax}) + 1`,
          })
          .where(eq(companies.id, companyId))
          .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

        const issueNumber = company.issueCounter;
        const identifier = `${company.issuePrefix}-${issueNumber}`;

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
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
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
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) =>
      db.transaction(async (tx) => {
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
      }),

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
      return comments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
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

    getComment: (commentId: string) =>
      instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? redactIssueComment(comment, censorUsernameInLogs) : null;
        })),

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
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          createdByRunId: actor.runId ?? null,
          body: redactedBody,
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
      const resolved = new Set<string>(explicitAgentMentionIds);
      for (const agent of rows) {
        if (tokens.has(agent.name.toLowerCase())) {
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
