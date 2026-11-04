import { withAgentAppearance } from "@paperclipai/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companyMemberships,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  issueThreadInteractions,
} from "@paperclipai/db";
import { executionIssueCondition } from "./issue-visibility.js";

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

function activeTimelineUser(companyId: string | SQL, userId: SQL) {
  return sql<boolean>`exists (select 1 from ${companyMemberships}
    where ${companyMemberships.companyId} = ${companyId}
      and ${companyMemberships.principalType} = 'user'
      and ${companyMemberships.principalId} = ${userId}
      and ${companyMemberships.status} = 'active')`;
}

/** Scalar ownership facts for bounded recorded creation and change events. */
function timelineOwnershipProjection() {
  const record = (value: SQL) => sql`case when jsonb_typeof(${value}) = 'object' then ${value} else '{}'::jsonb end`;
  const details = record(sql`${activityLog.details}`);
  const previous = record(sql`${details} -> '_previous'`);
  const changes = record(sql`${details} -> 'changes'`);
  const canonical = sql`${activityLog.action} = 'issue.updated' and jsonb_typeof(${details} -> 'changes') = 'object'`;
  const changed = ["assigneeAgentId", "assigneeUserId"].map(key => {
    const change = record(sql`${changes} -> ${key}`);
    return sql`case when ${canonical} then
      (${change} ? 'from' and ${change} ? 'to' and (${change} -> 'from') is distinct from (${change} -> 'to'))
      else (${details} ? ${key} and (not (${previous} ? ${key}) or (${details} -> ${key}) is distinct from (${previous} -> ${key}))) end`;
  });
  const stringValue = (value: SQL) => sql<string | null>`case when jsonb_typeof(${value}) = 'string'
    then nullif(btrim(${value} #>> '{}'), '') else null end`;
  const targetValue = (key: string, legacyKey: string) => sql`case when ${canonical} then ${changes} -> ${key} -> 'to'
    when ${details} ? ${key} then ${details} -> ${key} else ${details} -> ${legacyKey} end`;
  const target = (key: string, legacyKey: string) => stringValue(targetValue(key, legacyKey));
  const creationAgentId = stringValue(sql`${details} -> 'assigneeAgentId'`);
  const creationUserId = stringValue(sql`${details} -> 'assigneeUserId'`);
  const sameCompanyAgent = (id: SQL) => sql`exists (select 1 from ${agents}
    where ${agents.id} = case when ${id} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then ${id}::uuid else null end and ${agents.companyId} = ${activityLog.companyId})`;
  const knownUser = (id: SQL) => sql`(exists (select 1 from ${authUsers} where ${authUsers.id} = ${id})
    and ${activeTimelineUser(sql`${activityLog.companyId}`, id)})`;
  const creationOwnerTypes = ["assigneeAgentId", "assigneeUserId"].map(key => sql`${details} ? ${key}
    and jsonb_typeof(${details} -> ${key}) in ('string', 'null')`);
  const cleared = ([["assigneeAgentId", "toAgentId"], ["assigneeUserId", "toUserId"]] as const).map(([key, alias], index) => sql`(
    (case when ${canonical} or ${details} ? ${key} then ${changed[index]} else ${details} ? ${alias} end)
    and jsonb_typeof(${targetValue(key, alias)}) = 'null')`);
  return {
    recorded: sql<boolean>`coalesce(position('assign' in ${activityLog.action}) > 0 or
      (${activityLog.action} = 'issue.updated' and (${sql.join(changed, sql` or `)})), false)`,
    cleared: sql<boolean>`coalesce(${sql.join(cleared, sql` or `)}, false)`,
    creationRecorded: sql<boolean>`coalesce((${activityLog.action} = 'issue.created'
        or (${activityLog.action} = 'issue.child_created' and ${details} -> 'createdByRequest' = 'true'::jsonb))
      and (${sql.join(creationOwnerTypes, sql` and `)})
      and ((${creationAgentId} is not null and ${creationUserId} is null and ${sameCompanyAgent(creationAgentId)})
        or (${creationUserId} is not null and ${creationAgentId} is null and ${knownUser(creationUserId)}))
      and ((${activityLog.actorType} = 'agent' and ${sameCompanyAgent(sql`${activityLog.actorId}`)})
        or (${activityLog.actorType} = 'user' and ${knownUser(sql`${activityLog.actorId}`)})), false)`,
    creationAgentId,
    creationUserId,
    creationParentId: stringValue(sql`${details} -> 'parentId'`),
    agentId: target("assigneeAgentId", "toAgentId"),
    userId: target("assigneeUserId", "toUserId"),
  };
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
      executionIssueCondition(),
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
          executionIssueCondition(),
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
          .select({ id: agents.id, name: agents.name, icon: agents.icon, appearance: agents.appearance })
          .from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, maybeUuidList(agentIds))))
        : [],
      userIds.length > 0
        ? db
          .select({ id: authUsers.id, name: authUsers.name, image: authUsers.image })
          .from(authUsers)
          .where(and(inArray(authUsers.id, maybeUuidList(userIds)), activeTimelineUser(companyId, sql`${authUsers.id}`)))
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
    const issueById = new Map(sortedIssues.map((issue) => [issue.id, issue]));
    const readableIssueIds = pagedIssues.map((issue) => issue.id);

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

    const ownership = timelineOwnershipProjection();
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
          creationRecorded: ownership.creationRecorded,
          creationParentId: ownership.creationParentId,
          creationAgentId: ownership.creationAgentId,
          creationUserId: ownership.creationUserId,
          assignmentCleared: ownership.cleared,
          assignmentRecorded: ownership.recorded,
          assignmentAgentId: ownership.agentId,
          assignmentUserId: ownership.userId,
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

    // The first visible receipt is selected before validating its facts. A
    // later replay must not rescue an unknown original or invent its owner.
    const creationReceipts = new Map<string, typeof logRows[number]>();
    for (const row of logRows) {
      if (row.action !== "issue.created" && row.action !== "issue.child_created") continue;
      const first = creationReceipts.get(row.issueId);
      if (!first || row.createdAt < first.createdAt) creationReceipts.set(row.issueId, row);
    }

    for (const row of logRows) {
      const logActorType = row.actorType === "agent" || row.actorType === "user" || row.actorType === "plugin"
        ? row.actorType : "system";
      const fromActorId = actorId(logActorType, row.actorId);
      if (row.action === "issue.created" || row.action === "issue.child_created") {
        const issue = issueById.get(row.issueId);
        if (creationReceipts.get(row.issueId) !== row || !row.creationRecorded || !issue
          || issue.createdAt < from || issue.createdAt > to) continue;
        const toActorId = row.creationAgentId ? actorId("agent", row.creationAgentId)
          : actorId("user", row.creationUserId!);
        actorIds.add(fromActorId);
        actorIds.add(toActorId);
        edges.push({ fromActorId, toActorId, issueId: row.issueId, at: row.createdAt.toISOString(), kind: "assignment" });
        // Delegation is the recorded creating agent's action under a readable
        // parent, not an inference from that parent's mutable current owner.
        if (logActorType === "agent" && row.creationParentId
          && row.creationParentId !== row.issueId && issueById.has(row.creationParentId) && fromActorId !== toActorId) {
          edges.push({ fromActorId, toActorId, issueId: row.issueId, at: row.createdAt.toISOString(), kind: "delegation" });
          events.push({ actorId: fromActorId, kind: "delegated", issueId: row.issueId, at: row.createdAt.toISOString() });
        }
        continue;
      }
      if (!row.assignmentRecorded) continue;
      const toActorId = row.assignmentAgentId ? actorId("agent", row.assignmentAgentId)
        : row.assignmentUserId ? actorId("user", row.assignmentUserId) : null;
      if (!toActorId && !row.assignmentCleared) continue;
      actorIds.add(fromActorId);
      events.push({ actorId: fromActorId, kind: toActorId ? "assigned" : "unassigned", issueId: row.issueId, at: row.createdAt.toISOString() });
      if (!toActorId) continue;
      actorIds.add(toActorId);
      edges.push({ fromActorId, toActorId, issueId: row.issueId, at: row.createdAt.toISOString(), kind: "assignment" });
    }

    const actorMaps = await loadActorMaps(input.companyId, actorIds);
    const publicActorIds = new Set(Array.from(actorIds).filter(id => {
      if (id.startsWith("agent:")) return actorMaps.agents.has(id.slice("agent:".length));
      if (id.startsWith("user:")) return actorMaps.users.has(id.slice("user:".length));
      return true;
    }));
    const actors: WorkTimelineActor[] = Array.from(publicActorIds).map((id) => {
      const [type, rawId] = id.split(":", 2) as [TimelineActorType, string];
      if (type === "agent") {
        const agent = actorMaps.agents.get(rawId);
        const identity = withAgentAppearance(agent ?? { id: rawId });
        return { id, type, name: agent?.name ?? "Unknown agent", avatar: identity.avatarUrl, appearance: identity.appearance, avatarUrl: identity.avatarUrl };
      }
      if (type === "user") {
        const user = actorMaps.users.get(rawId);
        return { id, type, name: user?.name ?? rawId, avatar: user?.image ?? null };
      }
      return { id, type, name: type === "plugin" ? rawId : "System", avatar: null };
    });

    return {
      actors,
      spans: Array.from(spanByRunId.values()).filter(span => publicActorIds.has(span.actorId)).sort((left, right) => left.start.localeCompare(right.start)),
      events: events.filter(event => publicActorIds.has(event.actorId)).sort((left, right) => left.at.localeCompare(right.at)),
      edges: edges.filter(edge => publicActorIds.has(edge.fromActorId) && publicActorIds.has(edge.toActorId)).sort((left, right) => left.at.localeCompare(right.at)),
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
