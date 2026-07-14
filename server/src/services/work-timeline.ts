import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { visibleIssueCondition } from "./issue-visibility.js";

// DTO types are shared with the UI via @paperclipai/shared so both sides consume
// one contract. Re-exported here for back-compat with existing server imports.
import type {
  TimelineActorType,
  WorkTimelineActor,
  WorkTimelineSpan,
  WorkTimelineEvent,
  WorkTimelineEdge,
  WorkTimelineResult,
} from "@paperclipai/shared";

export type {
  TimelineActorType,
  TimelineEventKind,
  TimelineEdgeKind,
  WorkTimelineActor,
  WorkTimelineSpan,
  WorkTimelineEvent,
  WorkTimelineEdge,
  WorkTimelineResult,
} from "@paperclipai/shared";

export interface WorkTimelineQuery {
  companyId: string;
  from?: Date;
  to?: Date;
  userId?: string;
  goalId?: string;
  projectId?: string;
  issueId?: string;
  limit?: number;
  offset?: number;
  canReadIssue?: (issue: WorkTimelineIssueAccessInput) => Promise<boolean>;
}

export interface WorkTimelineIssueAccessInput {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
}

type IssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  identifier: string | null;
  title: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  createdAt: Date;
};

type RunUsage = NonNullable<WorkTimelineSpan["usage"]>;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SOURCE_ROWS = 5_000;
const ACL_FILTER_CONCURRENCY = 16;

function actorId(type: TimelineActorType, id: string) {
  return `${type}:${id}`;
}

function normalizeLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function normalizeOffset(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

export function normalizeTimelineWindow(input: { from?: Date; to?: Date }, now = new Date()) {
  const rawTo = input.to ?? now;
  const to = rawTo.getTime() > now.getTime() ? now : rawTo;
  const requestedFrom = input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
  let from = requestedFrom;
  let capped = false;
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    from = new Date(to.getTime() - MAX_WINDOW_MS);
    capped = true;
  }
  if (from.getTime() > to.getTime()) {
    from = new Date(to.getTime() - DEFAULT_WINDOW_MS);
    capped = true;
  }
  return { from, to, capped };
}

function dateIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readUsageToken(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = readNumber(source[key]);
    if (value != null) return Math.max(0, Math.floor(value));
  }
  return 0;
}

function normalizeRunUsage(usageJson: unknown): RunUsage | null {
  if (!usageJson || typeof usageJson !== "object" || Array.isArray(usageJson)) return null;
  const source = usageJson as Record<string, unknown>;
  const inputTokens = readUsageToken(source, "inputTokens", "input_tokens", "rawInputTokens", "raw_input_tokens");
  const cachedInputTokens = readUsageToken(
    source,
    "cachedInputTokens",
    "cached_input_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
  );
  const outputTokens = readUsageToken(source, "outputTokens", "output_tokens", "rawOutputTokens", "raw_output_tokens");
  const totalTokens = inputTokens + cachedInputTokens + outputTokens;
  return totalTokens > 0 ? { inputTokens, cachedInputTokens, outputTokens, totalTokens } : null;
}

function maybeUuidList(ids: Iterable<string>) {
  return Array.from(new Set(Array.from(ids).filter((id) => id.length > 0)));
}

function runOverlapsWindow(from: Date, to: Date) {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return and(
    sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${toIso}::timestamptz`,
    sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${fromIso}::timestamptz`,
  );
}

export function workTimelineService(db: Db) {
  async function filterReadableIssues(
    rows: IssueRow[],
    canReadIssue: NonNullable<WorkTimelineQuery["canReadIssue"]> | undefined,
  ) {
    if (!canReadIssue) return rows;

    const allowedRows: IssueRow[] = [];
    for (let index = 0; index < rows.length; index += ACL_FILTER_CONCURRENCY) {
      const batch = rows.slice(index, index + ACL_FILTER_CONCURRENCY);
      const decisions = await Promise.all(batch.map(async (issue) => ({
        issue,
        allowed: await canReadIssue({
          id: issue.id,
          companyId: issue.companyId,
          projectId: issue.projectId,
          parentId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId,
          status: issue.status,
        }),
      })));
      for (const decision of decisions) {
        if (decision.allowed) allowedRows.push(decision.issue);
      }
    }
    return allowedRows;
  }

  async function collectIssueIds(input: WorkTimelineQuery, from: Date, to: Date) {
    const ids = new Set<string>();

    if (input.issueId) {
      ids.add(input.issueId);
    }

    const filterConditions = [
      eq(issues.companyId, input.companyId),
      visibleIssueCondition(),
      input.goalId ? eq(issues.goalId, input.goalId) : undefined,
      input.projectId ? eq(issues.projectId, input.projectId) : undefined,
      input.issueId ? eq(issues.id, input.issueId) : undefined,
    ].filter(Boolean);

    const recentlyTouched = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          ...filterConditions,
          or(
            and(gte(issues.createdAt, from), lte(issues.createdAt, to)),
            and(gte(issues.updatedAt, from), lte(issues.updatedAt, to)),
          ),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of recentlyTouched) ids.add(row.id);

    const runContextRows = await db
      .select({ issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          runOverlapsWindow(from, to),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' is not null`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of runContextRows) {
      if (row.issueId) ids.add(row.issueId);
    }

    const activityIssueRows = await db
      .select({ issueId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          gte(activityLog.createdAt, from),
          lte(activityLog.createdAt, to),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of activityIssueRows) ids.add(row.issueId);

    const commentIssueRows = await db
      .select({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, input.companyId),
          isNull(issueComments.deletedAt),
          gte(issueComments.createdAt, from),
          lte(issueComments.createdAt, to),
        ),
      )
      .orderBy(desc(issueComments.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of commentIssueRows) ids.add(row.issueId);

    const interactionIssueRows = await db
      .select({ issueId: issueThreadInteractions.issueId })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          or(
            and(gte(issueThreadInteractions.createdAt, from), lte(issueThreadInteractions.createdAt, to)),
            and(gte(issueThreadInteractions.resolvedAt, from), lte(issueThreadInteractions.resolvedAt, to)),
          ),
        ),
      )
      .orderBy(desc(issueThreadInteractions.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of interactionIssueRows) ids.add(row.issueId);

    const approvalIssueRows = await db
      .select({ issueId: issueApprovals.issueId })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          or(
            and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
            and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
          ),
        ),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(MAX_SOURCE_ROWS);
    for (const row of approvalIssueRows) ids.add(row.issueId);

    return maybeUuidList(ids);
  }

  async function loadIssues(input: WorkTimelineQuery, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    return db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        identifier: issues.identifier,
        title: issues.title,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        status: issues.status,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
          inArray(issues.id, issueIds),
          input.goalId ? eq(issues.goalId, input.goalId) : undefined,
          input.projectId ? eq(issues.projectId, input.projectId) : undefined,
          input.issueId ? eq(issues.id, input.issueId) : undefined,
        ),
      );
  }

  async function applyUserLens(input: WorkTimelineQuery, rows: IssueRow[], from: Date, to: Date) {
    if (!input.userId) return rows;

    const byId = new Map(rows.map((issue) => [issue.id, issue]));
    const selected = new Set<string>();
    for (const issue of rows) {
      if (issue.createdByUserId === input.userId || issue.assigneeUserId === input.userId) selected.add(issue.id);
    }

    const [commentRows, approvalRows, interactionRows, activityRows] = await Promise.all([
      db
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, input.companyId),
            eq(issueComments.authorUserId, input.userId),
            isNull(issueComments.deletedAt),
            gte(issueComments.createdAt, from),
            lte(issueComments.createdAt, to),
          ),
        ),
      db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, input.companyId),
            eq(approvals.decidedByUserId, input.userId),
            gte(approvals.decidedAt, from),
            lte(approvals.decidedAt, to),
          ),
        ),
      db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.resolvedByUserId, input.userId),
            gte(issueThreadInteractions.resolvedAt, from),
            lte(issueThreadInteractions.resolvedAt, to),
          ),
        ),
      db
        .select({ issueId: activityLog.entityId })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.actorType, "user"),
            eq(activityLog.actorId, input.userId),
            eq(activityLog.entityType, "issue"),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    for (const row of [...commentRows, ...approvalRows, ...interactionRows, ...activityRows]) {
      selected.add(row.issueId);
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const issue of rows) {
        if (issue.parentId && selected.has(issue.parentId) && !selected.has(issue.id)) {
          selected.add(issue.id);
          changed = true;
        }
      }
    }

    return rows.filter((issue) => selected.has(issue.id) || byId.get(issue.parentId ?? "") && selected.has(issue.parentId ?? ""));
  }

  async function loadActorMaps(companyId: string, actorIds: Set<string>) {
    const agentIds = Array.from(actorIds)
      .filter((id) => id.startsWith("agent:"))
      .map((id) => id.slice("agent:".length));
    const userIds = Array.from(actorIds)
      .filter((id) => id.startsWith("user:"))
      .map((id) => id.slice("user:".length));

    const [agentRows, userRows] = await Promise.all([
      agentIds.length > 0
        ? db
          .select({ id: agents.id, name: agents.name, icon: agents.icon })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, maybeUuidList(agentIds))))
        : [],
      userIds.length > 0
        ? db
          .select({ id: authUsers.id, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(inArray(authUsers.id, maybeUuidList(userIds)))
        : [],
    ]);

    return {
      agents: new Map(agentRows.map((agent) => [agent.id, agent])),
      users: new Map(userRows.map((user) => [user.id, user])),
    };
  }

  function actorForIssueCreator(issue: IssueRow) {
    if (issue.createdByAgentId) return actorId("agent", issue.createdByAgentId);
    if (issue.createdByUserId) return actorId("user", issue.createdByUserId);
    return actorId("system", "system");
  }

  function actorForIssueAssignee(issue: IssueRow) {
    if (issue.assigneeAgentId) return actorId("agent", issue.assigneeAgentId);
    if (issue.assigneeUserId) return actorId("user", issue.assigneeUserId);
    return null;
  }

  async function getTimeline(input: WorkTimelineQuery): Promise<WorkTimelineResult> {
    const { from, to, capped } = normalizeTimelineWindow(input);
    const limit = normalizeLimit(input.limit);
    const offset = normalizeOffset(input.offset);

    const candidateIssueIds = await collectIssueIds(input, from, to);
    const loadedIssues = await loadIssues(input, candidateIssueIds);
    const userScopedIssues = await applyUserLens(input, loadedIssues, from, to);
    const accessibleIssues = await filterReadableIssues(userScopedIssues, input.canReadIssue);
    const sortedIssues = accessibleIssues.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    const pagedIssues = sortedIssues.slice(offset, offset + limit);
    const issueById = new Map(pagedIssues.map((issue) => [issue.id, issue]));
    const readableIssueIds = Array.from(issueById.keys());

    if (readableIssueIds.length === 0) {
      return {
        actors: [],
        spans: [],
        events: [],
        edges: [],
        pagination: { limit, offset, totalIssues: sortedIssues.length, hasMore: offset + limit < sortedIssues.length },
        window: { from: from.toISOString(), to: to.toISOString(), capped },
      };
    }

    const actorIds = new Set<string>();
    const events: WorkTimelineEvent[] = [];
    const edges: WorkTimelineEdge[] = [];

    for (const issue of pagedIssues) {
      const creatorActorId = actorForIssueCreator(issue);
      actorIds.add(creatorActorId);
      events.push({
        actorId: creatorActorId,
        kind: "created",
        issueId: issue.id,
        at: issue.createdAt.toISOString(),
      });

      const assigneeActorId = actorForIssueAssignee(issue);
      if (assigneeActorId) {
        actorIds.add(assigneeActorId);
        edges.push({
          fromActorId: creatorActorId,
          toActorId: assigneeActorId,
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
          kind: "assignment",
        });
      }

      const parent = issue.parentId ? issueById.get(issue.parentId) : null;
      const parentActorId = parent ? actorForIssueAssignee(parent) ?? actorForIssueCreator(parent) : null;
      if (parentActorId && assigneeActorId && parentActorId !== assigneeActorId) {
        actorIds.add(parentActorId);
        edges.push({
          fromActorId: parentActorId,
          toActorId: assigneeActorId,
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
          kind: "delegation",
        });
        events.push({
          actorId: parentActorId,
          kind: "delegated",
          issueId: issue.id,
          at: issue.createdAt.toISOString(),
        });
      }
    }

    const [contextRunRows, activityRunRows, commentRows, approvalRows, interactionRows, logRows] = await Promise.all([
      db
        .select({
          runId: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          invocationSource: heartbeatRuns.invocationSource,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, input.companyId),
            runOverlapsWindow(from, to),
            inArray(sql<string>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`, readableIssueIds),
          ),
        ),
      db
        .select({
          runId: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          issueId: activityLog.entityId,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          invocationSource: heartbeatRuns.invocationSource,
          usageJson: heartbeatRuns.usageJson,
        })
        .from(activityLog)
        .innerJoin(heartbeatRuns, eq(activityLog.runId, heartbeatRuns.id))
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(heartbeatRuns.companyId, input.companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, readableIssueIds),
            runOverlapsWindow(from, to),
          ),
        ),
      db
        .select({
          issueId: issueComments.issueId,
          authorAgentId: issueComments.authorAgentId,
          authorUserId: issueComments.authorUserId,
          createdAt: issueComments.createdAt,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, input.companyId),
            isNull(issueComments.deletedAt),
            inArray(issueComments.issueId, readableIssueIds),
            gte(issueComments.createdAt, from),
            lte(issueComments.createdAt, to),
          ),
        ),
      db
        .select({
          issueId: issueApprovals.issueId,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          createdAt: approvals.createdAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, input.companyId),
            inArray(issueApprovals.issueId, readableIssueIds),
            or(
              and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
              and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
            ),
          ),
        ),
      db
        .select({
          issueId: issueThreadInteractions.issueId,
          resolvedByAgentId: issueThreadInteractions.resolvedByAgentId,
          resolvedByUserId: issueThreadInteractions.resolvedByUserId,
          resolvedAt: issueThreadInteractions.resolvedAt,
          createdByAgentId: issueThreadInteractions.createdByAgentId,
          createdByUserId: issueThreadInteractions.createdByUserId,
          createdAt: issueThreadInteractions.createdAt,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, input.companyId),
            inArray(issueThreadInteractions.issueId, readableIssueIds),
            or(
              and(gte(issueThreadInteractions.createdAt, from), lte(issueThreadInteractions.createdAt, to)),
              and(gte(issueThreadInteractions.resolvedAt, from), lte(issueThreadInteractions.resolvedAt, to)),
            ),
          ),
        ),
      db
        .select({
          issueId: activityLog.entityId,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, readableIssueIds),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    const spanByRunId = new Map<string, WorkTimelineSpan>();
    for (const row of [...contextRunRows, ...activityRunRows]) {
      if (!row.issueId || !issueById.has(row.issueId) || spanByRunId.has(row.runId)) continue;
      const runActorId = actorId("agent", row.agentId);
      actorIds.add(runActorId);
      spanByRunId.set(row.runId, {
        actorId: runActorId,
        laneHint: row.invocationSource ?? null,
        runId: row.runId,
        issueId: row.issueId,
        issueIdentifier: issueById.get(row.issueId)?.identifier ?? null,
        issueTitle: issueById.get(row.issueId)?.title ?? null,
        start: (row.startedAt ?? row.createdAt).toISOString(),
        end: dateIso(row.finishedAt),
        status: row.status,
        retryOfRunId: row.retryOfRunId ?? null,
        continuationAttempt: row.continuationAttempt,
        invocationSource: row.invocationSource ?? null,
        usage: normalizeRunUsage(row.usageJson),
      });
    }

    for (const row of commentRows) {
      const commentActorId = row.authorAgentId
        ? actorId("agent", row.authorAgentId)
        : row.authorUserId
          ? actorId("user", row.authorUserId)
          : actorId("system", "system");
      actorIds.add(commentActorId);
      events.push({ actorId: commentActorId, kind: "commented", issueId: row.issueId, at: row.createdAt.toISOString() });
    }

    for (const row of approvalRows) {
      const approvalActorId = row.decidedByUserId
        ? actorId("user", row.decidedByUserId)
        : row.requestedByAgentId
          ? actorId("agent", row.requestedByAgentId)
          : row.requestedByUserId
            ? actorId("user", row.requestedByUserId)
            : actorId("system", "system");
      actorIds.add(approvalActorId);
      events.push({
        actorId: approvalActorId,
        kind: "approved",
        issueId: row.issueId,
        at: (row.decidedAt ?? row.createdAt).toISOString(),
      });
    }

    for (const row of interactionRows) {
      const interactionActorId = row.resolvedByUserId
        ? actorId("user", row.resolvedByUserId)
        : row.resolvedByAgentId
          ? actorId("agent", row.resolvedByAgentId)
          : row.createdByAgentId
            ? actorId("agent", row.createdByAgentId)
            : row.createdByUserId
              ? actorId("user", row.createdByUserId)
              : actorId("system", "system");
      actorIds.add(interactionActorId);
      events.push({
        actorId: interactionActorId,
        kind: "approved",
        issueId: row.issueId,
        at: (row.resolvedAt ?? row.createdAt).toISOString(),
      });
    }

    for (const row of logRows) {
      const logActorType = row.actorType === "agent" || row.actorType === "user" || row.actorType === "plugin"
        ? row.actorType
        : "system";
      const fromActorId = actorId(logActorType, row.actorId);
      actorIds.add(fromActorId);
      if (row.action.includes("assign")) {
        events.push({ actorId: fromActorId, kind: "assigned", issueId: row.issueId, at: row.createdAt.toISOString() });
        const details = row.details && typeof row.details === "object" && !Array.isArray(row.details)
          ? row.details as Record<string, unknown>
          : {};
        const targetAgentId = readString(details.assigneeAgentId) ?? readString(details.toAgentId);
        const targetUserId = readString(details.assigneeUserId) ?? readString(details.toUserId);
        const toActorId = targetAgentId
          ? actorId("agent", targetAgentId)
          : targetUserId
            ? actorId("user", targetUserId)
            : null;
        if (toActorId) {
          actorIds.add(toActorId);
          edges.push({
            fromActorId,
            toActorId,
            issueId: row.issueId,
            at: row.createdAt.toISOString(),
            kind: "assignment",
          });
        }
      }
    }

    const actorMaps = await loadActorMaps(input.companyId, actorIds);
    const actors: WorkTimelineActor[] = Array.from(actorIds).map((id) => {
      const [type, rawId] = id.split(":", 2) as [TimelineActorType, string];
      if (type === "agent") {
        const agent = actorMaps.agents.get(rawId);
        return { id, type, name: agent?.name ?? "Unknown agent", avatar: agent?.icon ?? null };
      }
      if (type === "user") {
        const user = actorMaps.users.get(rawId);
        return { id, type, name: user?.name ?? rawId, avatar: user?.image ?? null };
      }
      return { id, type, name: type === "plugin" ? rawId : "System", avatar: null };
    });

    return {
      actors,
      spans: Array.from(spanByRunId.values()).sort((left, right) => left.start.localeCompare(right.start)),
      events: events.sort((left, right) => left.at.localeCompare(right.at)),
      edges: edges.sort((left, right) => left.at.localeCompare(right.at)),
      pagination: {
        limit,
        offset,
        totalIssues: sortedIssues.length,
        hasMore: offset + limit < sortedIssues.length,
      },
      window: { from: from.toISOString(), to: to.toISOString(), capped },
    };
  }

  return { getTimeline };
}
