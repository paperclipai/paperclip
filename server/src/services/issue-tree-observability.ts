import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type {
  IssueStatus,
  IssueTreeObservability,
  IssueTreeObservabilityBlockerExplanation,
  IssueTreeObservabilityNode,
  IssueTreeObservabilitySeverity,
  IssueTreeObservabilityTimelineEntry,
  IssueTreeObservabilityTimelineKind,
} from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

const DEFAULT_TIMELINE_LIMIT = 40;
const MAX_TIMELINE_LIMIT = 100;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out", "cancelled", "error"]);
const DONE_ISSUE_STATUSES = new Set(["done"]);
const CANCELLED_ISSUE_STATUSES = new Set(["cancelled"]);
const ACTIVE_ISSUE_TERMINAL_STATUSES = new Set(["done", "cancelled"]);

export interface IssueTreeObservabilityOptions {
  limit?: number;
  now?: Date;
}

type DateLike = Date | string;

type IssueTreeRow = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  parentId: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  depth: number | string;
  createdAt: DateLike;
  updatedAt: DateLike;
};

type RunLinkRow = {
  issueId: string;
  runId: string;
  status: string;
  startedAt: DateLike | null;
  finishedAt: DateLike | null;
  createdAt: DateLike;
  error: string | null;
  errorCode: string | null;
};

type BlockerRow = {
  issueId: string;
  blockerIssueId: string;
  blockerIdentifier: string | null;
  blockerTitle: string;
  blockerStatus: string;
  blockerAssigneeAgentId: string | null;
  blockerAssigneeUserId: string | null;
};

type CostRow = {
  id: string;
  issueId: string;
  runId: string | null;
  provider: string;
  model: string;
  costCents: number | string;
  inputTokens: number | string;
  cachedInputTokens: number | string;
  outputTokens: number | string;
  occurredAt: DateLike;
};

type ActivityRow = {
  id: string;
  issueId: string;
  runId: string | null;
  action: string;
  details: unknown;
  createdAt: DateLike;
};

type ErrorEventRow = {
  id: number | string;
  issueId: string;
  runId: string;
  eventType: string;
  level: string | null;
  stream: string | null;
  message: string | null;
  createdAt: DateLike;
};

function normalizeTimelineLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_TIMELINE_LIMIT;
  return Math.max(1, Math.min(MAX_TIMELINE_LIMIT, Math.floor(limit ?? DEFAULT_TIMELINE_LIMIT)));
}

function numberValue(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDate(value: DateLike | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? date : null;
}

function dateMillis(value: DateLike | null | undefined) {
  return toDate(value)?.getTime() ?? null;
}

function runRuntimeMs(run: RunLinkRow, now: Date) {
  const startedMs = dateMillis(run.startedAt);
  if (startedMs === null) return 0;
  const finishedMs = dateMillis(run.finishedAt) ?? now.getTime();
  if (!Number.isFinite(finishedMs) || finishedMs < startedMs) return 0;
  return finishedMs - startedMs;
}

function timestampMs(value: DateLike | null | undefined) {
  const ms = dateMillis(value);
  return ms === null ? Number.NEGATIVE_INFINITY : ms;
}

function latestDate(existing: DateLike | null, next: DateLike | null | undefined) {
  const existingDate = toDate(existing);
  const nextDate = toDate(next);
  if (!nextDate) return existingDate;
  if (!existingDate) return nextDate;
  return nextDate.getTime() > existingDate.getTime() ? nextDate : existingDate;
}

function sanitizeMessage(message: string | null | undefined) {
  if (!message) return null;
  const redacted = redactSensitiveText(message).replaceAll("***REDACTED***", "[REDACTED]");
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function stableTimelineId(kind: IssueTreeObservabilityTimelineKind, id: string | number, issueId: string) {
  return `${kind}:${issueId}:${String(id)}`;
}

function issueDisplayName(identifier: string | null, title: string) {
  return identifier ? `${identifier} (${title})` : title;
}

function blockerState(status: string): IssueTreeObservabilityBlockerExplanation["state"] {
  return ACTIVE_ISSUE_TERMINAL_STATUSES.has(status) ? "suppressed_terminal" : "canonical_active";
}

function buildBlockerExplanation(
  issue: IssueTreeRow,
  blocker: BlockerRow,
): IssueTreeObservabilityBlockerExplanation {
  const blockedName = issueDisplayName(issue.identifier, issue.title);
  const blockerName = issueDisplayName(blocker.blockerIdentifier, blocker.blockerTitle);
  const state = blockerState(blocker.blockerStatus);
  const nextOwnerAgentId = state === "canonical_active" ? blocker.blockerAssigneeAgentId : null;
  const nextOwnerUserId = state === "canonical_active" ? blocker.blockerAssigneeUserId : null;
  let explanation: string;
  if (state === "suppressed_terminal") {
    explanation = `${blockedName} is not canonically blocked by ${blockerName}; the blocker is ${blocker.blockerStatus}.`;
  } else if (nextOwnerAgentId || nextOwnerUserId) {
    explanation = `${blockedName} is blocked by canonical active blocker ${blockerName}; next owner is ${nextOwnerAgentId ? `agent ${nextOwnerAgentId}` : `user ${nextOwnerUserId}`}.`;
  } else {
    explanation = `${blockedName} is blocked by canonical active blocker ${blockerName}; no next owner is assigned.`;
  }
  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    blockerIssueId: blocker.blockerIssueId,
    blockerIdentifier: blocker.blockerIdentifier,
    blockerTitle: blocker.blockerTitle,
    blockerStatus: blocker.blockerStatus as IssueStatus,
    state,
    explanation,
    nextOwnerAgentId,
    nextOwnerUserId,
  };
}

function runSeverity(status: string): IssueTreeObservabilitySeverity {
  if (FAILED_RUN_STATUSES.has(status)) return "error";
  if (status === "succeeded" || status === "completed") return "success";
  if (ACTIVE_RUN_STATUSES.has(status)) return "warning";
  return "info";
}

function runLabel(status: string) {
  if (FAILED_RUN_STATUSES.has(status)) return "Run failed";
  if (status === "succeeded" || status === "completed") return "Run succeeded";
  if (ACTIVE_RUN_STATUSES.has(status)) return "Run active";
  return "Run updated";
}

function rowsFromExecute<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export async function buildIssueTreeObservability(
  db: Db,
  companyId: string,
  issueId: string,
  options: IssueTreeObservabilityOptions = {},
): Promise<IssueTreeObservability> {
  const now = options.now ?? new Date();
  const timelineLimit = normalizeTimelineLimit(options.limit);

  const issueRows = rowsFromExecute<IssueTreeRow>(await db.execute(sql`
    WITH RECURSIVE issue_tree AS (
      SELECT
        i.id,
        i.identifier,
        i.title,
        i.status,
        i.parent_id AS "parentId",
        i.assignee_agent_id AS "assigneeAgentId",
        i.assignee_user_id AS "assigneeUserId",
        0::int AS depth,
        i.created_at AS "createdAt",
        i.updated_at AS "updatedAt"
      FROM issues i
      WHERE i.company_id = ${companyId}
        AND i.id = ${issueId}
        AND i.hidden_at IS NULL
      UNION ALL
      SELECT
        child.id,
        child.identifier,
        child.title,
        child.status,
        child.parent_id AS "parentId",
        child.assignee_agent_id AS "assigneeAgentId",
        child.assignee_user_id AS "assigneeUserId",
        issue_tree.depth + 1 AS depth,
        child.created_at AS "createdAt",
        child.updated_at AS "updatedAt"
      FROM issues child
      JOIN issue_tree ON child.parent_id = issue_tree.id
      WHERE child.company_id = ${companyId}
        AND child.hidden_at IS NULL
    )
    SELECT * FROM issue_tree
    ORDER BY depth ASC, "createdAt" ASC, id ASC
  `));

  const issueIds = issueRows.map((row) => row.id);
  const issueIdSet = new Set(issueIds);
  const issueById = new Map(issueRows.map((row) => [row.id, row]));

  const nodesById = new Map<string, IssueTreeObservabilityNode>();
  for (const row of issueRows) {
    nodesById.set(row.id, {
      id: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status as IssueStatus,
      parentId: row.parentId,
      depth: numberValue(row.depth),
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      runCount: 0,
      activeRunCount: 0,
      failedRunCount: 0,
      errorEventCount: 0,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runtimeMs: 0,
      lastActivityAt: latestDate(row.updatedAt ?? null, row.createdAt),
      latestRunStatus: null,
      latestRunId: null,
    });
  }

  const blockerRows = issueIds.length > 0
    ? rowsFromExecute<BlockerRow>(await db.execute(sql`
        WITH issue_ids(id) AS (
          VALUES ${sql.join(issueIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        )
        SELECT
          ir.related_issue_id AS "issueId",
          blocker.id AS "blockerIssueId",
          blocker.identifier AS "blockerIdentifier",
          blocker.title AS "blockerTitle",
          blocker.status AS "blockerStatus",
          blocker.assignee_agent_id AS "blockerAssigneeAgentId",
          blocker.assignee_user_id AS "blockerAssigneeUserId"
        FROM issue_relations ir
        JOIN issue_ids ON issue_ids.id = ir.related_issue_id
        JOIN issues blocker ON blocker.id = ir.issue_id
        WHERE ir.company_id = ${companyId}
          AND ir.type = 'blocks'
          AND blocker.company_id = ${companyId}
          AND blocker.hidden_at IS NULL
        ORDER BY
          CASE WHEN blocker.status IN ('done', 'cancelled') THEN 1 ELSE 0 END ASC,
          blocker.updated_at DESC,
          blocker.id ASC
      `))
    : [];

  const blockerExplanations = blockerRows
    .map((blocker) => {
      const issue = issueById.get(blocker.issueId);
      return issue ? buildBlockerExplanation(issue, blocker) : null;
    })
    .filter((entry): entry is IssueTreeObservabilityBlockerExplanation => Boolean(entry));

  const runRows = issueIds.length > 0
    ? rowsFromExecute<RunLinkRow>(await db.execute(sql`
        WITH issue_ids(id) AS (
          VALUES ${sql.join(issueIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        ), run_links AS (
          SELECT DISTINCT
            (hr.context_snapshot ->> 'issueId')::uuid AS issue_id,
            hr.id AS run_id
          FROM heartbeat_runs hr
          JOIN issue_ids ON issue_ids.id::text = hr.context_snapshot ->> 'issueId'
          WHERE hr.company_id = ${companyId}
          UNION
          SELECT DISTINCT
            al.entity_id::uuid AS issue_id,
            al.run_id AS run_id
          FROM activity_log al
          JOIN issue_ids ON issue_ids.id::text = al.entity_id
          WHERE al.company_id = ${companyId}
            AND al.entity_type = 'issue'
            AND al.run_id IS NOT NULL
        )
        SELECT
          run_links.issue_id AS "issueId",
          hr.id AS "runId",
          hr.status,
          hr.started_at AS "startedAt",
          hr.finished_at AS "finishedAt",
          hr.created_at AS "createdAt",
          hr.error,
          hr.error_code AS "errorCode"
        FROM run_links
        JOIN heartbeat_runs hr ON hr.id = run_links.run_id
        WHERE hr.company_id = ${companyId}
        ORDER BY hr.created_at DESC, hr.id DESC
      `))
    : [];

  const costRows = issueIds.length > 0
    ? rowsFromExecute<CostRow>(await db.execute(sql`
        WITH issue_ids(id) AS (
          VALUES ${sql.join(issueIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        )
        SELECT
          ce.id,
          ce.issue_id AS "issueId",
          ce.heartbeat_run_id AS "runId",
          ce.provider,
          ce.model,
          ce.cost_cents AS "costCents",
          ce.input_tokens AS "inputTokens",
          ce.cached_input_tokens AS "cachedInputTokens",
          ce.output_tokens AS "outputTokens",
          ce.occurred_at AS "occurredAt"
        FROM cost_events ce
        JOIN issue_ids ON issue_ids.id = ce.issue_id
        WHERE ce.company_id = ${companyId}
        ORDER BY ce.occurred_at DESC, ce.id DESC
      `))
    : [];

  const activityRows = issueIds.length > 0
    ? rowsFromExecute<ActivityRow>(await db.execute(sql`
        WITH issue_ids(id) AS (
          VALUES ${sql.join(issueIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        )
        SELECT
          al.id,
          al.entity_id AS "issueId",
          al.run_id AS "runId",
          al.action,
          al.details,
          al.created_at AS "createdAt"
        FROM activity_log al
        JOIN issue_ids ON issue_ids.id::text = al.entity_id
        WHERE al.company_id = ${companyId}
          AND al.entity_type = 'issue'
        ORDER BY al.created_at DESC, al.id DESC
      `))
    : [];

  const runIssuePairs = new Set(runRows.map((row) => `${row.runId}:${row.issueId}`));
  const runIds = [...new Set(runRows.map((row) => row.runId))];
  const errorRows = runIds.length > 0
    ? rowsFromExecute<ErrorEventRow>(await db.execute(sql`
        WITH run_ids(id) AS (
          VALUES ${sql.join(runIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        ), issue_ids(id) AS (
          VALUES ${sql.join(issueIds.map((id) => sql`(${id}::uuid)`), sql`, `)}
        ), run_links AS (
          SELECT DISTINCT
            (hr.context_snapshot ->> 'issueId')::uuid AS issue_id,
            hr.id AS run_id
          FROM heartbeat_runs hr
          JOIN issue_ids ON issue_ids.id::text = hr.context_snapshot ->> 'issueId'
          JOIN run_ids ON run_ids.id = hr.id
          WHERE hr.company_id = ${companyId}
          UNION
          SELECT DISTINCT
            al.entity_id::uuid AS issue_id,
            al.run_id AS run_id
          FROM activity_log al
          JOIN issue_ids ON issue_ids.id::text = al.entity_id
          JOIN run_ids ON run_ids.id = al.run_id
          WHERE al.company_id = ${companyId}
            AND al.entity_type = 'issue'
            AND al.run_id IS NOT NULL
        )
        SELECT
          hre.id,
          run_links.issue_id AS "issueId",
          hre.run_id AS "runId",
          hre.event_type AS "eventType",
          hre.level,
          hre.stream,
          hre.message,
          hre.created_at AS "createdAt"
        FROM heartbeat_run_events hre
        JOIN run_links ON run_links.run_id = hre.run_id
        WHERE hre.company_id = ${companyId}
          AND (
            lower(coalesce(hre.level, '')) = 'error'
            OR lower(coalesce(hre.stream, '')) = 'stderr'
            OR lower(hre.event_type) like '%error%'
          )
        ORDER BY hre.created_at DESC, hre.id DESC
      `))
    : [];

  const latestRunTimestampByNode = new Map<string, number>();
  for (const run of runRows) {
    if (!issueIdSet.has(run.issueId)) continue;
    const node = nodesById.get(run.issueId);
    if (!node) continue;
    node.runCount += 1;
    if (ACTIVE_RUN_STATUSES.has(run.status)) node.activeRunCount += 1;
    if (FAILED_RUN_STATUSES.has(run.status)) node.failedRunCount += 1;
    node.runtimeMs += runRuntimeMs(run, now);
    node.lastActivityAt = latestDate(node.lastActivityAt, run.finishedAt ?? run.startedAt ?? run.createdAt);
    const runTs = timestampMs(run.createdAt);
    if ((latestRunTimestampByNode.get(run.issueId) ?? Number.NEGATIVE_INFINITY) < runTs) {
      latestRunTimestampByNode.set(run.issueId, runTs);
      node.latestRunStatus = run.status;
      node.latestRunId = run.runId;
    }
  }

  for (const cost of costRows) {
    const node = nodesById.get(cost.issueId);
    if (!node) continue;
    node.costCents += numberValue(cost.costCents);
    node.inputTokens += numberValue(cost.inputTokens);
    node.cachedInputTokens += numberValue(cost.cachedInputTokens);
    node.outputTokens += numberValue(cost.outputTokens);
    node.lastActivityAt = latestDate(node.lastActivityAt, cost.occurredAt);
  }

  for (const activity of activityRows) {
    const node = nodesById.get(activity.issueId);
    if (!node) continue;
    node.lastActivityAt = latestDate(node.lastActivityAt, activity.createdAt);
  }

  for (const event of errorRows) {
    const node = nodesById.get(event.issueId);
    if (!node) continue;
    node.errorEventCount += 1;
    node.lastActivityAt = latestDate(node.lastActivityAt, event.createdAt);
  }

  const nodes = [...nodesById.values()];
  const summary = nodes.reduce<IssueTreeObservability["summary"]>((acc, node) => {
    acc.issueCount += 1;
    if (!ACTIVE_ISSUE_TERMINAL_STATUSES.has(node.status)) acc.activeIssueCount += 1;
    if (DONE_ISSUE_STATUSES.has(node.status)) acc.doneIssueCount += 1;
    if (CANCELLED_ISSUE_STATUSES.has(node.status)) acc.cancelledIssueCount += 1;
    if (node.status === "blocked") acc.blockedIssueCount += 1;
    acc.runCount += node.runCount;
    acc.activeRunCount += node.activeRunCount;
    acc.failedRunCount += node.failedRunCount;
    acc.errorEventCount += node.errorEventCount;
    acc.costCents += node.costCents;
    acc.inputTokens += node.inputTokens;
    acc.cachedInputTokens += node.cachedInputTokens;
    acc.outputTokens += node.outputTokens;
    acc.runtimeMs += node.runtimeMs;
    acc.lastActivityAt = latestDate(acc.lastActivityAt, node.lastActivityAt);
    return acc;
  }, {
    issueId,
    issueCount: 0,
    activeIssueCount: 0,
    doneIssueCount: 0,
    cancelledIssueCount: 0,
    blockedIssueCount: 0,
    runCount: 0,
    activeRunCount: 0,
    failedRunCount: 0,
    errorEventCount: 0,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runtimeMs: 0,
    lastActivityAt: null,
  });

  const timeline: IssueTreeObservabilityTimelineEntry[] = [];
  for (const run of runRows) {
    const issue = issueById.get(run.issueId);
    const timestamp = toDate(run.finishedAt ?? run.startedAt ?? run.createdAt);
    if (!issue || !timestamp) continue;
    timeline.push({
      id: stableTimelineId("run", run.runId, run.issueId),
      kind: "run",
      severity: runSeverity(run.status),
      issueId: run.issueId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      runId: run.runId,
      timestamp,
      label: runLabel(run.status),
      message: sanitizeMessage(run.error ?? run.errorCode ?? null),
      costCents: null,
    });
  }

  for (const cost of costRows) {
    const issue = issueById.get(cost.issueId);
    const timestamp = toDate(cost.occurredAt);
    if (!issue || !timestamp) continue;
    timeline.push({
      id: stableTimelineId("cost", cost.id, cost.issueId),
      kind: "cost",
      severity: "info",
      issueId: cost.issueId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      runId: cost.runId,
      timestamp,
      label: "Cost recorded",
      message: sanitizeMessage(`${cost.provider} ${cost.model}`),
      costCents: numberValue(cost.costCents),
    });
  }

  for (const event of errorRows) {
    const issue = issueById.get(event.issueId);
    const timestamp = toDate(event.createdAt);
    if (!issue || !timestamp || !runIssuePairs.has(`${event.runId}:${event.issueId}`)) continue;
    timeline.push({
      id: stableTimelineId("error", event.id, event.issueId),
      kind: "error",
      severity: "error",
      issueId: event.issueId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      runId: event.runId,
      timestamp,
      label: event.eventType,
      message: sanitizeMessage(event.message),
      costCents: null,
    });
  }

  for (const activity of activityRows) {
    const issue = issueById.get(activity.issueId);
    const timestamp = toDate(activity.createdAt);
    if (!issue || !timestamp) continue;
    timeline.push({
      id: stableTimelineId("activity", activity.id, activity.issueId),
      kind: "activity",
      severity: "info",
      issueId: activity.issueId,
      issueIdentifier: issue.identifier,
      issueTitle: issue.title,
      runId: activity.runId,
      timestamp,
      label: activity.action,
      message: sanitizeMessage(
        activity.details && typeof activity.details === "object"
          ? JSON.stringify(activity.details)
          : null,
      ),
      costCents: null,
    });
  }

  timeline.sort((a, b) => {
    const byTime = b.timestamp.getTime() - a.timestamp.getTime();
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });

  return {
    issueId,
    generatedAt: now,
    summary,
    nodes,
    blockerExplanations,
    timeline: timeline.slice(0, timelineLimit),
  };
}
