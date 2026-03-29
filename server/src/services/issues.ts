import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  assets,
  companies,
  companyMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueAttachments,
  issueLabels,
  issueComments,
  issueDocuments,
  issueReadStates,
  issues,
  labels,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { extractAgentMentionIds, extractProjectMentionIds, isUuidLike } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;

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

export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  parentId?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  includeRoutineExecutions?: boolean;
  q?: string;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asCanonicalUuid(value: unknown): string | undefined {
  if (typeof value !== "string" || !isUuidLike(value)) return undefined;
  return value.trim().toLowerCase();
}

function assertOptionalUuidField(value: unknown, fieldName: string) {
  if (value == null) return;
  if (typeof value !== "string" || !isUuidLike(value.trim())) {
    throw unprocessable(`Invalid ${fieldName}`);
  }
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
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  const normalizedCheckoutRunId = typeof checkoutRunId === "string" ? checkoutRunId.trim().toLowerCase() : null;
  const normalizedActorRunId = typeof actorRunId === "string" ? actorRunId.trim().toLowerCase() : null;
  if (normalizedActorRunId) return normalizedCheckoutRunId === normalizedActorRunId;
  return normalizedCheckoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
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

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      issueId: issueLabels.issueId,
      label: labels,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.issueId);
    if (existing) existing.push(row.label);
    else map.set(row.issueId, [row.label]);
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

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

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
        inArray(heartbeatRuns.id, runIds),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );

  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const normalizedAgentId = asCanonicalUuid(agentId);
    if (!normalizedAgentId) throw unprocessable("Invalid assigneeAgentId");
    const normalizedCompanyId = asCanonicalUuid(companyId) ?? companyId;
    const assignee = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, normalizedAgentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== normalizedCompanyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
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

  async function assertValidProjectWorkspace(companyId: string, projectId: string | null | undefined, projectWorkspaceId: string) {
    const normalizedProjectWorkspaceId = asCanonicalUuid(projectWorkspaceId);
    if (!normalizedProjectWorkspaceId) throw unprocessable("Invalid projectWorkspaceId");
    const normalizedProjectId = projectId == null ? null : asCanonicalUuid(projectId);
    if (projectId && !normalizedProjectId) throw unprocessable("Invalid projectId");
    const normalizedCompanyId = asCanonicalUuid(companyId) ?? companyId;
    const workspace = await db
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, normalizedProjectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== normalizedCompanyId) throw unprocessable("Project workspace must belong to same company");
    if (normalizedProjectId && workspace.projectId !== normalizedProjectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidExecutionWorkspace(companyId: string, projectId: string | null | undefined, executionWorkspaceId: string) {
    const normalizedExecutionWorkspaceId = asCanonicalUuid(executionWorkspaceId);
    if (!normalizedExecutionWorkspaceId) throw unprocessable("Invalid executionWorkspaceId");
    const normalizedProjectId = projectId == null ? null : asCanonicalUuid(projectId);
    if (projectId && !normalizedProjectId) throw unprocessable("Invalid projectId");
    const normalizedCompanyId = asCanonicalUuid(companyId) ?? companyId;
    const workspace = await db
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, normalizedExecutionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== normalizedCompanyId) throw unprocessable("Execution workspace must belong to same company");
    if (normalizedProjectId && workspace.projectId !== normalizedProjectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const normalizedCompanyId = asCanonicalUuid(companyId) ?? companyId;
    const normalizedLabelIds = labelIds.map((id) => asCanonicalUuid(id));
    if (normalizedLabelIds.some((id) => !id)) {
      throw unprocessable("One or more labels must be valid UUIDs");
    }
    const canonicalLabelIds = normalizedLabelIds.filter((id): id is string => id != null);
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, normalizedCompanyId), inArray(labels.id, canonicalLabelIds)));
    if (existing.length !== new Set(canonicalLabelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
    return canonicalLabelIds;
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    const normalizedLabelIds = await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (!normalizedLabelIds || normalizedLabelIds.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      normalizedLabelIds.map((labelId) => ({
        issueId,
        labelId,
        companyId,
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

  return {
    list: async (companyId: string, filters?: IssueFilters) => {
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) return [];
      const statusFilter = asNonEmptyString(filters?.status)?.toLowerCase();
      const assigneeAgentIdFilterRaw = asNonEmptyString(filters?.assigneeAgentId);
      const participantAgentIdFilterRaw = asNonEmptyString(filters?.participantAgentId);
      const assigneeUserIdFilter = asNonEmptyString(filters?.assigneeUserId);
      const touchedByUserIdFilter = asNonEmptyString(filters?.touchedByUserId);
      const unreadForUserIdFilter = asNonEmptyString(filters?.unreadForUserId);
      const projectIdFilterRaw = asNonEmptyString(filters?.projectId);
      const parentIdFilterRaw = asNonEmptyString(filters?.parentId);
      const labelIdFilterRaw = asNonEmptyString(filters?.labelId);
      const originKindFilter = asNonEmptyString(filters?.originKind)?.toLowerCase();
      const originIdFilterRaw = asNonEmptyString(filters?.originId);
      const originIdFilter =
        originKindFilter === "routine_execution" && originIdFilterRaw && isUuidLike(originIdFilterRaw)
          ? originIdFilterRaw.toLowerCase()
          : originIdFilterRaw;
      const includeRoutineExecutionsRaw = filters?.includeRoutineExecutions as unknown;
      const includeRoutineExecutions =
        includeRoutineExecutionsRaw === true ||
        includeRoutineExecutionsRaw === 1 ||
        (typeof includeRoutineExecutionsRaw === "string" &&
          (includeRoutineExecutionsRaw.trim().toLowerCase() === "true" ||
            includeRoutineExecutionsRaw.trim().toLowerCase() === "1"));
      const rawSearch = asNonEmptyString(filters?.q) ?? "";
      if (assigneeAgentIdFilterRaw && !isUuidLike(assigneeAgentIdFilterRaw)) return [];
      if (participantAgentIdFilterRaw && !isUuidLike(participantAgentIdFilterRaw)) return [];
      if (projectIdFilterRaw && !isUuidLike(projectIdFilterRaw)) return [];
      if (parentIdFilterRaw && !isUuidLike(parentIdFilterRaw)) return [];
      if (labelIdFilterRaw && !isUuidLike(labelIdFilterRaw)) return [];
      const assigneeAgentIdFilter = assigneeAgentIdFilterRaw ? assigneeAgentIdFilterRaw.trim().toLowerCase() : null;
      const participantAgentIdFilter = participantAgentIdFilterRaw ? participantAgentIdFilterRaw.trim().toLowerCase() : null;
      const projectIdFilter = projectIdFilterRaw ? projectIdFilterRaw.trim().toLowerCase() : null;
      const parentIdFilter = parentIdFilterRaw ? parentIdFilterRaw.trim().toLowerCase() : null;
      const labelIdFilter = labelIdFilterRaw ? labelIdFilterRaw.trim().toLowerCase() : null;
      const conditions = [eq(issues.companyId, normalizedCompanyId)];
      const touchedByUserId = touchedByUserIdFilter;
      const unreadForUserId = unreadForUserIdFilter;
      const contextUserId = unreadForUserId ?? touchedByUserId;
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
            AND ${issueComments.companyId} = ${normalizedCompanyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (statusFilter) {
        const statuses = statusFilter.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (assigneeAgentIdFilter) {
        conditions.push(eq(issues.assigneeAgentId, assigneeAgentIdFilter));
      }
      if (participantAgentIdFilter) {
        conditions.push(participatedByAgentCondition(normalizedCompanyId, participantAgentIdFilter));
      }
      if (assigneeUserIdFilter) {
        conditions.push(eq(issues.assigneeUserId, assigneeUserIdFilter));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(normalizedCompanyId, touchedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(normalizedCompanyId, unreadForUserId));
      }
      if (projectIdFilter) conditions.push(eq(issues.projectId, projectIdFilter));
      if (parentIdFilter) conditions.push(eq(issues.parentId, parentIdFilter));
      if (originKindFilter) conditions.push(eq(issues.originKind, originKindFilter));
      if (originIdFilter) conditions.push(eq(issues.originId, originIdFilter));
      if (labelIdFilter) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, normalizedCompanyId), eq(issueLabels.labelId, labelIdFilter)));
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
      if (!includeRoutineExecutions && !originKindFilter && !originIdFilter) {
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
          WHEN ${descriptionContainsMatch} THEN 4
          WHEN ${commentContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const rows = await db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(hasSearch ? asc(searchOrder) : asc(priorityOrder), asc(priorityOrder), desc(issues.updatedAt));
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (!contextUserId || withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const statsRows = await db
        .select({
          issueId: issueComments.issueId,
          myLastCommentAt: sql<Date | null>`
            MAX(CASE WHEN ${issueComments.authorUserId} = ${contextUserId} THEN ${issueComments.createdAt} END)
          `,
          lastExternalCommentAt: sql<Date | null>`
            MAX(
              CASE
                WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${contextUserId}
                THEN ${issueComments.createdAt}
              END
            )
          `,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, normalizedCompanyId),
            inArray(issueComments.issueId, issueIds),
          ),
        )
        .groupBy(issueComments.issueId);
      const readRows = await db
        .select({
          issueId: issueReadStates.issueId,
          myLastReadAt: issueReadStates.lastReadAt,
        })
        .from(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, normalizedCompanyId),
            eq(issueReadStates.userId, contextUserId),
            inArray(issueReadStates.issueId, issueIds),
          ),
        );
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => ({
        ...row,
        ...deriveIssueUserContext(row, contextUserId, {
          myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
          myLastReadAt: readByIssueId.get(row.id) ?? null,
          lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
        }),
      }));
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) return 0;
      if (typeof userId !== "string" || userId.trim().length === 0) return 0;
      const normalizedUserId = userId.trim();
      const conditions = [
        eq(issues.companyId, normalizedCompanyId),
        isNull(issues.hiddenAt),
        unreadForUserCondition(normalizedCompanyId, normalizedUserId),
        ne(issues.originKind, "routine_execution"),
      ];
      const normalizedStatus = asNonEmptyString(status)?.toLowerCase();
      if (normalizedStatus) {
        const statuses = normalizedStatus.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) throw unprocessable("Invalid companyId");
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) throw notFound("Issue not found");
      if (typeof userId !== "string" || userId.trim().length === 0) throw unprocessable("Invalid userId");
      if (!(readAt instanceof Date) || Number.isNaN(readAt.getTime())) throw unprocessable("Invalid readAt");
      const issue = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, normalizedIssueId), eq(issues.companyId, normalizedCompanyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const normalizedUserId = userId.trim();
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId: normalizedCompanyId,
          issueId: normalizedIssueId,
          userId: normalizedUserId,
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

    getById: async (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return null;
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, normalizedId))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    getByIdentifier: async (identifier: string) => {
      const normalizedIdentifier = asNonEmptyString(identifier);
      if (!normalizedIdentifier) return null;
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, normalizedIdentifier.toUpperCase()))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    create: async (
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & { labelIds?: string[] },
    ) => {
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) throw unprocessable("Invalid companyId");
      const { labelIds: inputLabelIds, ...issueData } = data;
      assertOptionalUuidField(issueData.projectId, "projectId");
      assertOptionalUuidField(issueData.parentId, "parentId");
      assertOptionalUuidField(issueData.goalId, "goalId");
      assertOptionalUuidField(issueData.assigneeAgentId, "assigneeAgentId");
      assertOptionalUuidField(issueData.projectWorkspaceId, "projectWorkspaceId");
      assertOptionalUuidField(issueData.executionWorkspaceId, "executionWorkspaceId");
      if (issueData.projectId) issueData.projectId = issueData.projectId.trim().toLowerCase();
      if (issueData.parentId) issueData.parentId = issueData.parentId.trim().toLowerCase();
      if (issueData.goalId) issueData.goalId = issueData.goalId.trim().toLowerCase();
      if (issueData.assigneeAgentId) issueData.assigneeAgentId = issueData.assigneeAgentId.trim().toLowerCase();
      if (issueData.projectWorkspaceId) issueData.projectWorkspaceId = issueData.projectWorkspaceId.trim().toLowerCase();
      if (issueData.executionWorkspaceId) issueData.executionWorkspaceId = issueData.executionWorkspaceId.trim().toLowerCase();
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      if (issueData.assigneeAgentId && issueData.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(normalizedCompanyId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(normalizedCompanyId, issueData.assigneeUserId);
      }
      if (issueData.projectWorkspaceId) {
        await assertValidProjectWorkspace(normalizedCompanyId, issueData.projectId, issueData.projectWorkspaceId);
      }
      if (issueData.executionWorkspaceId) {
        await assertValidExecutionWorkspace(normalizedCompanyId, issueData.projectId, issueData.executionWorkspaceId);
      }
      if (issueData.status === "in_progress" && !issueData.assigneeAgentId && !issueData.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, normalizedCompanyId);
        const projectGoalId = await getProjectDefaultGoalId(tx, normalizedCompanyId, issueData.projectId);
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        if (executionWorkspaceSettings == null && issueData.projectId) {
          const project = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, normalizedCompanyId)))
            .then((rows) => rows[0] ?? null);
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        if (!projectWorkspaceId && issueData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, normalizedCompanyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(
                eq(projectWorkspaces.projectId, issueData.projectId),
                eq(projectWorkspaces.companyId, normalizedCompanyId),
              ))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        const [company] = await tx
          .update(companies)
          .set({ issueCounter: sql`${companies.issueCounter} + 1` })
          .where(eq(companies.id, normalizedCompanyId))
          .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });
        if (!company) throw notFound("Company not found");

        const issueNumber = company.issueCounter;
        const identifier = `${company.issuePrefix}-${issueNumber}`;

        const values = {
          ...issueData,
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId: issueData.projectId,
            goalId: issueData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId: normalizedCompanyId,
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

        const [issue] = await tx.insert(issues).values(values).returning();
        if (inputLabelIds) {
          await syncIssueLabels(issue.id, normalizedCompanyId, inputLabelIds, tx);
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
      });
    },

    update: async (id: string, data: Partial<typeof issues.$inferInsert> & { labelIds?: string[] }) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return null;
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, normalizedId))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const { labelIds: nextLabelIds, ...issueData } = data;
      assertOptionalUuidField(issueData.projectId, "projectId");
      assertOptionalUuidField(issueData.parentId, "parentId");
      assertOptionalUuidField(issueData.goalId, "goalId");
      assertOptionalUuidField(issueData.assigneeAgentId, "assigneeAgentId");
      assertOptionalUuidField(issueData.projectWorkspaceId, "projectWorkspaceId");
      assertOptionalUuidField(issueData.executionWorkspaceId, "executionWorkspaceId");
      if (issueData.projectId) issueData.projectId = issueData.projectId.trim().toLowerCase();
      if (issueData.parentId) issueData.parentId = issueData.parentId.trim().toLowerCase();
      if (issueData.goalId) issueData.goalId = issueData.goalId.trim().toLowerCase();
      if (issueData.assigneeAgentId) issueData.assigneeAgentId = issueData.assigneeAgentId.trim().toLowerCase();
      if (issueData.projectWorkspaceId) issueData.projectWorkspaceId = issueData.projectWorkspaceId.trim().toLowerCase();
      if (issueData.executionWorkspaceId) issueData.executionWorkspaceId = issueData.executionWorkspaceId.trim().toLowerCase();
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
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
      }

      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.companyId);
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, existing.companyId, existing.projectId),
          getProjectDefaultGoalId(
            tx,
            existing.companyId,
            issueData.projectId !== undefined ? issueData.projectId : existing.projectId,
          ),
        ]);
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
          .where(eq(issues.id, normalizedId))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      });
    },

    remove: (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return Promise.resolve(null);
      return db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, normalizedId));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, normalizedId));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, normalizedId))
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
      });
    },

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const normalizedIssueId = asCanonicalUuid(id);
      if (!normalizedIssueId) throw notFound("Issue not found");
      const normalizedAgentId = asCanonicalUuid(agentId);
      if (!normalizedAgentId) throw unprocessable("Invalid agentId");
      let normalizedCheckoutRunId: string | null = null;
      if (checkoutRunId != null) {
        const parsedCheckoutRunId = asCanonicalUuid(checkoutRunId);
        if (!parsedCheckoutRunId) throw unprocessable("Invalid checkoutRunId");
        normalizedCheckoutRunId = parsedCheckoutRunId;
      }

      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.companyId, normalizedAgentId);
      const normalizedExpectedStatuses = (Array.isArray(expectedStatuses) ? expectedStatuses : [])
        .filter((status): status is string => typeof status === "string")
        .map((status) => status.trim().toLowerCase())
        .filter((status): status is (typeof ALL_ISSUE_STATUSES)[number] =>
          ALL_ISSUE_STATUSES.includes(status as (typeof ALL_ISSUE_STATUSES)[number]),
        );
      if (normalizedExpectedStatuses.length === 0) {
        throw unprocessable("expectedStatuses must include at least one valid issue status");
      }

      const now = new Date();
      const sameRunAssigneeCondition = normalizedCheckoutRunId
        ? and(
          eq(issues.assigneeAgentId, normalizedAgentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, normalizedCheckoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, normalizedAgentId), isNull(issues.checkoutRunId));
      const executionLockCondition = normalizedCheckoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, normalizedCheckoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: normalizedAgentId,
          assigneeUserId: null,
          checkoutRunId: normalizedCheckoutRunId,
          executionRunId: normalizedCheckoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, normalizedIssueId),
            inArray(issues.status, normalizedExpectedStatuses),
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
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === normalizedAgentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        normalizedCheckoutRunId
      ) {
        const staleExecutionLock =
          current.executionRunId !== null &&
          current.executionRunId !== normalizedCheckoutRunId &&
          (await isTerminalOrMissingHeartbeatRun(current.executionRunId));
        const executionCondition =
          current.executionRunId == null || current.executionRunId === normalizedCheckoutRunId
            ? or(isNull(issues.executionRunId), eq(issues.executionRunId, normalizedCheckoutRunId))
            : staleExecutionLock
              ? eq(issues.executionRunId, current.executionRunId)
              : null;
        if (!executionCondition) {
          throw conflict("Issue checkout conflict", {
            issueId: current.id,
            status: current.status,
            assigneeAgentId: current.assigneeAgentId,
            checkoutRunId: current.checkoutRunId,
            executionRunId: current.executionRunId,
          });
        }
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId: normalizedCheckoutRunId,
            executionRunId: normalizedCheckoutRunId,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, normalizedIssueId),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, normalizedAgentId),
              isNull(issues.checkoutRunId),
              executionCondition,
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        normalizedCheckoutRunId &&
        current.assigneeAgentId === normalizedAgentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== normalizedCheckoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: normalizedIssueId,
          actorAgentId: normalizedAgentId,
          actorRunId: normalizedCheckoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, normalizedIssueId)).then((rows) => rows[0]!);
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === normalizedAgentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, normalizedCheckoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, normalizedIssueId)).then((rows) => rows[0]!);
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
      const normalizedIssueId = asCanonicalUuid(id);
      if (!normalizedIssueId) throw notFound("Issue not found");
      const normalizedActorAgentId = asCanonicalUuid(actorAgentId);
      if (!normalizedActorAgentId) throw conflict("Issue run ownership conflict");
      let normalizedActorRunId: string | null = null;
      if (actorRunId) {
        const parsedActorRunId = asCanonicalUuid(actorRunId);
        if (!parsedActorRunId) throw conflict("Issue run ownership conflict");
        normalizedActorRunId = parsedActorRunId;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === normalizedActorAgentId &&
        sameRunLock(current.checkoutRunId, normalizedActorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        normalizedActorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === normalizedActorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== normalizedActorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: normalizedIssueId,
          actorAgentId: normalizedActorAgentId,
          actorRunId: normalizedActorRunId,
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
        actorAgentId: normalizedActorAgentId,
        actorRunId: normalizedActorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      const normalizedIssueId = asCanonicalUuid(id);
      if (!normalizedIssueId) return null;
      const normalizedActorAgentId = actorAgentId ? asCanonicalUuid(actorAgentId) : null;
      if (actorAgentId && !normalizedActorAgentId) throw conflict("Only assignee can release issue");
      let normalizedActorRunId: string | null = null;
      if (actorRunId) {
        const parsedActorRunId = asCanonicalUuid(actorRunId);
        if (!parsedActorRunId) throw conflict("Only checkout run can release issue");
        normalizedActorRunId = parsedActorRunId;
      }

      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (normalizedActorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== normalizedActorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        normalizedActorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === normalizedActorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, normalizedActorRunId)
      ) {
        throw conflict("Only checkout run can release issue", {
          issueId: existing.id,
          assigneeAgentId: existing.assigneeAgentId,
          checkoutRunId: existing.checkoutRunId,
          actorRunId: normalizedActorRunId,
        });
      }

      const updated = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, normalizedIssueId))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (companyId: string) => {
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) return Promise.resolve([]);
      return db
        .select()
        .from(labels)
        .where(eq(labels.companyId, normalizedCompanyId))
        .orderBy(asc(labels.name), asc(labels.id));
    },

    getLabelById: (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return Promise.resolve(null);
      return db
        .select()
        .from(labels)
        .where(eq(labels.id, normalizedId))
        .then((rows) => rows[0] ?? null);
    },

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const normalizedCompanyId = asCanonicalUuid(companyId);
      if (!normalizedCompanyId) throw unprocessable("Invalid companyId");
      const [created] = await db
        .insert(labels)
        .values({
          companyId: normalizedCompanyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return null;
      return db
        .delete(labels)
        .where(eq(labels.id, normalizedId))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const orderRaw = asNonEmptyString(opts?.order)?.toLowerCase();
      const order = orderRaw === "asc" ? "asc" : "desc";
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) return [];
      const afterCommentIdRaw = asNonEmptyString(opts?.afterCommentId) ?? null;
      const afterCommentId = afterCommentIdRaw ? afterCommentIdRaw.toLowerCase() : null;
      const rawLimit = opts?.limit as unknown;
      const hasExplicitLimit =
        rawLimit !== undefined &&
        rawLimit !== null &&
        !(typeof rawLimit === "string" && rawLimit.trim().length === 0);
      const parsedLimit =
        typeof rawLimit === "number"
          ? rawLimit
          : typeof rawLimit === "string" && rawLimit.trim().length > 0
            ? Number(rawLimit.trim())
            : null;
      const limit =
        typeof parsedLimit === "number" && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(Math.floor(parsedLimit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : hasExplicitLimit
            ? MAX_ISSUE_COMMENT_PAGE_LIMIT
            : null;
      if (afterCommentId && !isUuidLike(afterCommentId)) return [];

      const conditions = [eq(issueComments.issueId, normalizedIssueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, normalizedIssueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt = anchor.createdAt instanceof Date
          ? anchor.createdAt.toISOString()
          : anchor.createdAt;
        conditions.push(
          order === "asc"
            ? sql<boolean>`(
                ${issueComments.createdAt} > ${anchorCreatedAt}
                OR (${issueComments.createdAt} = ${anchorCreatedAt} AND ${issueComments.id} > ${anchor.id})
              )`
            : sql<boolean>`(
                ${issueComments.createdAt} < ${anchorCreatedAt}
                OR (${issueComments.createdAt} = ${anchorCreatedAt} AND ${issueComments.id} < ${anchor.id})
              )`,
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
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) {
        return {
          totalComments: 0,
          latestCommentId: null,
          latestCommentAt: null,
        };
      }
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, normalizedIssueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, normalizedIssueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: (commentId: string) => {
      const normalizedCommentId = asCanonicalUuid(commentId);
      if (!normalizedCommentId) return Promise.resolve(null);
      return instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
          .select()
          .from(issueComments)
          .where(eq(issueComments.id, normalizedCommentId))
          .then((rows) => {
            const comment = rows[0] ?? null;
            return comment ? redactIssueComment(comment, censorUsernameInLogs) : null;
          }));
    },

    addComment: async (issueId: string, body: string, actor: { agentId?: string; userId?: string }) => {
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) throw notFound("Issue not found");
      if (typeof body !== "string") throw unprocessable("Invalid comment body");
      const normalizedAuthorAgentId =
        actor.agentId == null
          ? null
          : asCanonicalUuid(actor.agentId);
      if (actor.agentId != null && !normalizedAuthorAgentId) throw unprocessable("Invalid authorAgentId");
      if (actor.userId != null && typeof actor.userId !== "string") throw unprocessable("Invalid authorUserId");
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");
      if (normalizedAuthorAgentId) {
        const authorAgent = await db
          .select({ id: agents.id, companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, normalizedAuthorAgentId))
          .then((rows) => rows[0] ?? null);
        if (!authorAgent || authorAgent.companyId !== issue.companyId) {
          throw unprocessable("Invalid authorAgentId");
        }
      }

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const [comment] = await db
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId: normalizedIssueId,
          authorAgentId: normalizedAuthorAgentId,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, normalizedIssueId));

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
      const normalizedIssueId = asCanonicalUuid(input.issueId);
      if (!normalizedIssueId) {
        throw notFound("Issue not found");
      }
      const normalizedIssueCommentId = input.issueCommentId == null
        ? null
        : asCanonicalUuid(input.issueCommentId);
      if (input.issueCommentId && !normalizedIssueCommentId) {
        throw notFound("Issue comment not found");
      }
      const normalizedCreatedByAgentId = input.createdByAgentId == null
        ? null
        : asCanonicalUuid(input.createdByAgentId);
      if (input.createdByAgentId != null && !normalizedCreatedByAgentId) {
        throw unprocessable("Invalid createdByAgentId");
      }
      if (input.createdByUserId != null && typeof input.createdByUserId !== "string") {
        throw unprocessable("Invalid createdByUserId");
      }
      const normalizedProvider = asNonEmptyString(input.provider);
      if (!normalizedProvider) throw unprocessable("Invalid provider");
      const normalizedObjectKey = asNonEmptyString(input.objectKey);
      if (!normalizedObjectKey) throw unprocessable("Invalid objectKey");
      const normalizedContentType = asNonEmptyString(input.contentType);
      if (!normalizedContentType) throw unprocessable("Invalid contentType");
      if (typeof input.byteSize !== "number" || !Number.isFinite(input.byteSize) || input.byteSize < 0) {
        throw unprocessable("Invalid byteSize");
      }
      const normalizedSha256 = asNonEmptyString(input.sha256);
      if (!normalizedSha256) throw unprocessable("Invalid sha256");
      if (input.originalFilename != null && typeof input.originalFilename !== "string") {
        throw unprocessable("Invalid originalFilename");
      }

      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (normalizedCreatedByAgentId) {
        const createdByAgent = await db
          .select({ id: agents.id, companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.id, normalizedCreatedByAgentId))
          .then((rows) => rows[0] ?? null);
        if (!createdByAgent || createdByAgent.companyId !== issue.companyId) {
          throw unprocessable("Invalid createdByAgentId");
        }
      }

      if (normalizedIssueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, normalizedIssueCommentId))
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
            provider: normalizedProvider,
            objectKey: normalizedObjectKey,
            contentType: normalizedContentType,
            byteSize: input.byteSize,
            sha256: normalizedSha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: normalizedCreatedByAgentId,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: normalizedIssueCommentId,
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

    listAttachments: async (issueId: string) => {
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) return [];
      return db
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
        .where(eq(issueAttachments.issueId, normalizedIssueId))
        .orderBy(desc(issueAttachments.createdAt));
    },

    getAttachmentById: async (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return null;
      return db
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
        .where(eq(issueAttachments.id, normalizedId))
        .then((rows) => rows[0] ?? null);
    },

    removeAttachment: async (id: string) => {
      const normalizedId = asCanonicalUuid(id);
      if (!normalizedId) return null;
      return db.transaction(async (tx) => {
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
          .where(eq(issueAttachments.id, normalizedId))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, normalizedId));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      });
    },

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const normalized = normalizeAgentMentionToken(m[1]);
        if (normalized) tokens.add(normalized.toLowerCase());
      }

      const explicitAgentMentionIds = extractAgentMentionIds(body).filter((agentId) => isUuidLike(agentId));
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

    findMentionedProjectIds: async (issueId: string) => {
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) return [];
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, normalizedIssueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, normalizedIssueId));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];
      const candidateProjectIds = [...new Set(
        [...mentionedIds]
          .map((projectId) => asCanonicalUuid(projectId))
          .filter((projectId): projectId is string => projectId != null),
      )];
      if (candidateProjectIds.length === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, candidateProjectIds),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return candidateProjectIds.filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const normalizedIssueId = asCanonicalUuid(issueId);
      if (!normalizedIssueId) return [];
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([normalizedIssueId]);
      const start = await db.select().from(issues).where(eq(issues.id, normalizedIssueId)).then(r => r[0] ?? null);
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
