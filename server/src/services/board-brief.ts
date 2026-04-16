import { and, desc, eq, gte, inArray, isNotNull, isNull, not, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  boardBriefSnapshots,
  companies,
  companyKpis,
  companyMemberships,
  costEvents,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueDocuments,
  issueWorkProducts,
  issues,
  joinRequests,
  projects,
} from "@paperclipai/db";
import type {
  BoardBrief,
  BoardBriefActionItem,
  BoardBriefFocusArea,
  BoardBriefIncident,
  BoardBriefOutput,
  BoardBriefSnapshot,
  CompanyKpi,
  DashboardAttentionItem,
  DashboardSummary,
  ExecutiveSummary,
  ExecutiveSummaryDispatchState,
  ExecutiveSummaryFailedRun,
  ExecutiveSummaryIssueTransition,
  ExecutiveSummaryTopChanges,
} from "@paperclipai/shared";
import { boardBriefSnapshotSchema } from "@paperclipai/shared";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import { parseSchedulerHeartbeatPolicy } from "./scheduler-heartbeat-policy.js";

const ACTIONABLE_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);
const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const ISSUE_TRANSITION_TARGET_STATUSES = new Set(["blocked", "in_progress", "done"]);

const BOARD_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_OPEN_ASSIGNED_ISSUE_MS = 24 * 60 * 60 * 1000;
const STALE_BLOCKED_ISSUE_AT_RISK_MS = 4 * 60 * 60 * 1000;
const STALE_BLOCKED_ISSUE_BLOCKED_MS = 8 * 60 * 60 * 1000;
const AGING_APPROVAL_WATCH_MS = 12 * 60 * 60 * 1000;
const AGING_APPROVAL_AT_RISK_MS = 24 * 60 * 60 * 1000;
const STALE_NON_SCHEDULER_AGENT_MS = 24 * 60 * 60 * 1000;
const FAILED_RUN_SPIKE_AT_RISK_WINDOW_MS = 6 * 60 * 60 * 1000;
const FAILED_RUN_SPIKE_BLOCKED_WINDOW_MS = 60 * 60 * 1000;
const COST_FRESHNESS_RUN_WINDOW_MS = 6 * 60 * 60 * 1000;
const COST_FRESHNESS_LAG_MS = 30 * 60 * 1000;
const SCHEMA_VERSION = 1 as const;

type CompanyRow = {
  id: string;
  name: string;
  budgetMonthlyCents: number;
  dailyExecutiveSummaryEnabled: boolean;
  criticalBoardAlertsEmailEnabled: boolean;
  dailyExecutiveSummaryLastSentAt: Date | null;
  dailyExecutiveSummaryLastStatus: string | null;
  dailyExecutiveSummaryLastError: string | null;
};

type AgentRow = {
  id: string;
  name: string;
  status: string;
  runtimeConfig: unknown;
  lastHeartbeatAt: Date | null;
  updatedAt: Date;
};

type IssueRow = {
  id: string;
  parentId: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  identifier: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type ApprovalRow = {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

type JoinRequestRow = {
  id: string;
  requestType: string;
  status: string;
  requestEmailSnapshot: string | null;
  agentName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type LatestRunRow = {
  id: string;
  agentId: string;
  agentName: string | null;
  agentStatus: string;
  status: string;
  error: string | null;
  contextSnapshot: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type TransitionActivityRow = {
  issueId: string;
  updatedAt: Date;
  details: Record<string, unknown> | null;
};

type WorkProductRow = {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  projectId: string | null;
  type: string;
  title: string;
  url: string | null;
  status: string;
  reviewState: string;
  summary: string | null;
  updatedAt: Date;
};

type DocumentRevisionRow = {
  id: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  projectId: string | null;
  documentId: string;
  documentTitle: string | null;
  revisionTitle: string | null;
  changeSummary: string | null;
  createdAt: Date;
};

type IssueActivityRow = {
  issueId: string;
  lastActivityAt: Date;
};

type IssueMovementRow = {
  issueId: string;
  lastUpdatedAt: Date;
};

type AgentActivityRow = {
  agentId: string | null;
  lastActivityAt: Date;
};

type BoardBriefContext = {
  brief: BoardBrief;
  company: CompanyRow;
  recipients: string[];
  topChanges: ExecutiveSummaryTopChanges;
};

type FocusAreaBucket = {
  key: string;
  label: string;
  href: string;
  tone: BoardBrief["health"]["tone"];
  changedIssueIds: Set<string>;
  memberIssueIds: Set<string>;
  blockedCount: number;
  failedRunCount: number;
  activeAgentIds: Set<string>;
  outputCount: number;
  latestAt: Date;
  latestUpdate: string;
};

function isOpenIssueStatus(status: string) {
  return OPEN_ISSUE_STATUSES.has(status);
}

function startOfLocalMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

function truncate(value: string, max = 280) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function humanizeToken(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

function maxDate(...values: Array<Date | null | undefined>) {
  const filtered = values.filter((value): value is Date => value instanceof Date);
  if (filtered.length === 0) return null;
  return new Date(Math.max(...filtered.map((value) => value.getTime())));
}

function severityRank(severity: BoardBriefActionItem["severity"] | BoardBriefIncident["severity"]): number {
  switch (severity) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function toneRank(tone: BoardBrief["health"]["tone"]): number {
  switch (tone) {
    case "blocked":
      return 4;
    case "at_risk":
      return 3;
    case "watch":
      return 2;
    case "healthy":
    default:
      return 1;
  }
}

function actionPriority(kind: BoardBriefActionItem["kind"]) {
  switch (kind) {
    case "approval":
    case "join_request":
      return 1;
    case "output":
    case "budget":
      return 2;
    case "run":
      return 3;
    case "agent":
      return 4;
    case "issue":
    default:
      return 5;
  }
}

function approvalTitle(row: ApprovalRow): string {
  const payloadTitle = typeof row.payload?.title === "string" ? row.payload.title : null;
  return payloadTitle ?? humanizeToken(row.type);
}

function joinRequestTitle(row: JoinRequestRow): string {
  if (row.requestType === "human") {
    return row.requestEmailSnapshot ? `${row.requestEmailSnapshot} requests access` : "Human join request";
  }
  if (row.agentName) return `Agent join request: ${row.agentName}`;
  return `${humanizeToken(row.requestType)} join request`;
}

function linkedIssueId(contextSnapshot: Record<string, unknown> | null): string | null {
  const issueId = contextSnapshot?.issueId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function linkedProjectId(payload: Record<string, unknown> | null): string | null {
  const direct = payload?.projectId;
  return typeof direct === "string" && direct.length > 0 ? direct : null;
}

function linkedApprovalIssueId(payload: Record<string, unknown> | null): string | null {
  const direct = payload?.issueId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const linked = payload?.linkedIssueId;
  return typeof linked === "string" && linked.length > 0 ? linked : null;
}

function topAncestorIssue(issue: IssueRow, issueById: ReadonlyMap<string, IssueRow>): IssueRow {
  let current = issue;
  const seen = new Set<string>([issue.id]);
  while (current.parentId) {
    const parent = issueById.get(current.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function focusAreaDescriptor(issue: IssueRow, issueById: ReadonlyMap<string, IssueRow>) {
  const root = topAncestorIssue(issue, issueById);
  if (issue.parentId || root.id !== issue.id) {
    return {
      key: `issue:${root.id}`,
      label: root.title,
      href: `/issues/${root.identifier ?? root.id}`,
    };
  }

  if (issue.projectId) {
    return {
      key: `project:${issue.projectId}`,
      label: issue.projectName ?? "Project work",
      href: `/projects/${issue.projectId}/issues`,
    };
  }

  return {
    key: "ops:general",
    label: "Operational work",
    href: "/issues",
  };
}

function ensureFocusArea(
  buckets: Map<string, FocusAreaBucket>,
  issue: IssueRow,
  issueById: ReadonlyMap<string, IssueRow>,
): FocusAreaBucket {
  const descriptor = focusAreaDescriptor(issue, issueById);
  const existing = buckets.get(descriptor.key);
  if (existing) return existing;

  const created: FocusAreaBucket = {
    key: descriptor.key,
    label: descriptor.label,
    href: descriptor.href,
    tone: "healthy",
    changedIssueIds: new Set<string>(),
    memberIssueIds: new Set<string>(),
    blockedCount: 0,
    failedRunCount: 0,
    activeAgentIds: new Set<string>(),
    outputCount: 0,
    latestAt: issue.updatedAt,
    latestUpdate: issue.title,
  };
  buckets.set(descriptor.key, created);
  return created;
}

function mapExecutiveSummaryStatus(value: string | null): ExecutiveSummaryDispatchState["lastStatus"] {
  return value === "ok" || value === "failed" || value === "skipped" ? value : null;
}

async function listManualKpis(companyId: string, database: Db | any): Promise<CompanyKpi[]> {
  return database
    .select()
    .from(companyKpis)
    .where(eq(companyKpis.companyId, companyId))
    .orderBy(companyKpis.position, companyKpis.createdAt);
}

async function resolveRecipientEmails(companyId: string, database: Db | any): Promise<string[]> {
  const rows = await database
    .select({ email: authUsers.email })
    .from(companyMemberships)
    .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        isNotNull(authUsers.email),
      ),
    );

  const deduped = new Map<string, string>();
  for (const row of rows) {
    const email = row.email.trim();
    if (!email) continue;
    deduped.set(email.toLowerCase(), email);
  }
  return [...deduped.values()];
}

function buildConfidence(freshness: BoardBrief["freshness"]): BoardBrief["confidence"] {
  if (freshness.execution.status === "stale" || freshness.cost.status === "stale") return "low";
  if (
    freshness.work.status === "stale"
    || freshness.approvals.status === "stale"
    || freshness.outputs.status === "stale"
  ) {
    return "medium";
  }
  return "high";
}

function computeOutputsMetric(outputs: BoardBriefOutput[]): BoardBrief["snapshot"]["outputs"] {
  const workProductCount = outputs.filter((output) => output.kind === "work_product").length;
  const documentCount = outputs.filter((output) => output.kind === "document_revision").length;
  return {
    value: String(outputs.length),
    label: "Outputs",
    headline: outputs.length > 0 ? "Fresh delivery evidence is available" : "No fresh outputs in the last 24 hours",
    detail: `${pluralize(workProductCount, "work product")} and ${pluralize(documentCount, "document revision")}`,
    tone: outputs.length > 0 ? "healthy" : "watch",
  };
}

function resolveLegacyDashboardHealth(input: {
  blockedIssues: number;
  failedRuns: number;
  activeBudgetIncidents: number;
  decisions: number;
  agentErrors: number;
  utilizationPercent: number;
}): DashboardSummary["brief"]["health"] {
  if (input.blockedIssues > 0 || input.activeBudgetIncidents > 0) return "blocked";
  if (input.failedRuns > 0 || input.agentErrors > 0) return "at_risk";
  if (input.decisions > 0 || input.utilizationPercent >= 80) return "watch";
  return "healthy";
}

async function buildContext(companyId: string, now: Date, database: Db | any): Promise<BoardBriefContext> {
  const company = await database
    .select({
      id: companies.id,
      name: companies.name,
      budgetMonthlyCents: companies.budgetMonthlyCents,
      dailyExecutiveSummaryEnabled: companies.dailyExecutiveSummaryEnabled,
      criticalBoardAlertsEmailEnabled: companies.criticalBoardAlertsEmailEnabled,
      dailyExecutiveSummaryLastSentAt: companies.dailyExecutiveSummaryLastSentAt,
      dailyExecutiveSummaryLastStatus: companies.dailyExecutiveSummaryLastStatus,
      dailyExecutiveSummaryLastError: companies.dailyExecutiveSummaryLastError,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows: CompanyRow[]) => rows[0] ?? null);

  if (!company) throw notFound("Company not found");

  const windowStart = new Date(now.getTime() - BOARD_WINDOW_MS);
  const monthStart = startOfLocalMonth(now);

  const [
    manualKpis,
    recipients,
    agentRows,
    taskRows,
    approvalRows,
    joinRequestRows,
    issueRows,
    issueActivityRows,
    issueWorkProductMovementRows,
    issueDocumentMovementRows,
    recentWorkProductRows,
    recentDocumentRevisionRows,
    latestRunRows,
    recentFailedRunRows,
    transitionRows,
    agentActivityRows,
    completedRecentlyRows,
    monthSpendRows,
    latestCostEventRows,
    budgetOverview,
  ] = await Promise.all([
    listManualKpis(companyId, database),
    resolveRecipientEmails(companyId, database),
    database
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
        lastHeartbeatAt: agents.lastHeartbeatAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), not(eq(agents.status, "terminated")))),
    database
      .select({ status: issues.status, count: sql<number>`count(*)` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          sql`${issues.originKind} <> 'board_copilot_thread'`,
        ),
      )
      .groupBy(issues.status),
    database
      .select({
        id: approvals.id,
        type: approvals.type,
        status: approvals.status,
        payload: approvals.payload,
        createdAt: approvals.createdAt,
        updatedAt: approvals.updatedAt,
      })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          sql`${approvals.status} in ('pending', 'revision_requested')`,
        ),
      )
      .orderBy(desc(approvals.updatedAt)),
    database
      .select({
        id: joinRequests.id,
        requestType: joinRequests.requestType,
        status: joinRequests.status,
        requestEmailSnapshot: joinRequests.requestEmailSnapshot,
        agentName: joinRequests.agentName,
        createdAt: joinRequests.createdAt,
        updatedAt: joinRequests.updatedAt,
      })
      .from(joinRequests)
      .where(and(eq(joinRequests.companyId, companyId), eq(joinRequests.status, "pending_approval")))
      .orderBy(desc(joinRequests.updatedAt)),
    database
      .select({
        id: issues.id,
        parentId: issues.parentId,
        projectId: issues.projectId,
        projectName: projects.name,
        title: issues.title,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        updatedAt: issues.updatedAt,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .leftJoin(projects, eq(issues.projectId, projects.id))
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          sql`${issues.originKind} <> 'board_copilot_thread'`,
        ),
      ),
    database
      .select({
        issueId: activityLog.entityId,
        lastActivityAt: sql<Date>`max(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue")))
      .groupBy(activityLog.entityId),
    database
      .select({
        issueId: issueWorkProducts.issueId,
        lastUpdatedAt: sql<Date>`max(${issueWorkProducts.updatedAt})`,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.companyId, companyId))
      .groupBy(issueWorkProducts.issueId),
    database
      .select({
        issueId: issueDocuments.issueId,
        lastUpdatedAt: sql<Date>`max(${documentRevisions.createdAt})`,
      })
      .from(documentRevisions)
      .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
      .where(eq(documentRevisions.companyId, companyId))
      .groupBy(issueDocuments.issueId),
    database
      .select({
        id: issueWorkProducts.id,
        issueId: issueWorkProducts.issueId,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        projectId: issues.projectId,
        type: issueWorkProducts.type,
        title: issueWorkProducts.title,
        url: issueWorkProducts.url,
        status: issueWorkProducts.status,
        reviewState: issueWorkProducts.reviewState,
        summary: issueWorkProducts.summary,
        updatedAt: issueWorkProducts.updatedAt,
      })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
      .where(and(eq(issueWorkProducts.companyId, companyId), gte(issueWorkProducts.updatedAt, windowStart)))
      .orderBy(desc(issueWorkProducts.updatedAt)),
    database
      .select({
        id: documentRevisions.id,
        issueId: issueDocuments.issueId,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        projectId: issues.projectId,
        documentId: documents.id,
        documentTitle: documents.title,
        revisionTitle: documentRevisions.title,
        changeSummary: documentRevisions.changeSummary,
        createdAt: documentRevisions.createdAt,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(documents.id, issueDocuments.documentId))
      .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
      .where(and(eq(documentRevisions.companyId, companyId), gte(documentRevisions.createdAt, windowStart)))
      .orderBy(desc(documentRevisions.createdAt)),
    database
      .selectDistinctOn([heartbeatRuns.agentId], {
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        agentStatus: agents.status,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(agents.companyId, companyId), not(eq(agents.status, "terminated"))))
      .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt)),
    database
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        agentStatus: agents.status,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .leftJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["failed", "timed_out"]),
          sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${windowStart.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`)),
    database
      .select({
        issueId: activityLog.entityId,
        updatedAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.updated"),
          gte(activityLog.createdAt, windowStart),
          sql`exists (
            select 1
            from ${issues}
            where ${issues.id}::text = ${activityLog.entityId}
              and ${issues.companyId} = ${companyId}
              and ${issues.originKind} <> 'board_copilot_thread'
          )`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(100),
    database
      .select({
        agentId: activityLog.agentId,
        lastActivityAt: sql<Date>`max(${activityLog.createdAt})`,
      })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), isNotNull(activityLog.agentId)))
      .groupBy(activityLog.agentId),
    database
      .select({ count: sql<number>`count(*)` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.status, "done"),
          isNull(issues.hiddenAt),
          gte(issues.updatedAt, windowStart),
          sql`${issues.originKind} <> 'board_copilot_thread'`,
        ),
      ),
    database
      .select({
        monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart))),
    database
      .select({ occurredAt: sql<Date>`max(${costEvents.occurredAt})` })
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId)),
    budgetService(database as Db).overview(companyId),
  ]);

  const pendingApprovals = (approvalRows as ApprovalRow[]).filter((row) => row.status === "pending").length;
  const completedRecently = Number(completedRecentlyRows[0]?.count ?? 0);
  const monthSpendCents = Number(monthSpendRows[0]?.monthSpend ?? 0);
  const utilization =
    company.budgetMonthlyCents > 0
      ? Number(((monthSpendCents / company.budgetMonthlyCents) * 100).toFixed(2))
      : 0;

  const allIssueRows = issueRows as IssueRow[];
  const openIssueRows = allIssueRows.filter((issue) => isOpenIssueStatus(issue.status));
  const issueById = new Map(openIssueRows.map((issue) => [issue.id, issue]));
  const issueActivityById = new Map<string, Date>();
  const workProductMovementByIssueId = new Map<string, Date>();
  const documentMovementByIssueId = new Map<string, Date>();
  const agentActivityById = new Map<string, Date>();

  for (const row of issueActivityRows as IssueActivityRow[]) {
    if (issueById.has(row.issueId)) issueActivityById.set(row.issueId, row.lastActivityAt);
  }
  for (const row of issueWorkProductMovementRows as IssueMovementRow[]) {
    workProductMovementByIssueId.set(row.issueId, row.lastUpdatedAt);
  }
  for (const row of issueDocumentMovementRows as IssueMovementRow[]) {
    documentMovementByIssueId.set(row.issueId, row.lastUpdatedAt);
  }
  for (const row of agentActivityRows as AgentActivityRow[]) {
    if (row.agentId) agentActivityById.set(row.agentId, row.lastActivityAt);
  }

  const issueMovementAt = new Map<string, Date>();
  const recentMovementIssueIds = new Set<string>();
  for (const issue of openIssueRows) {
    const movementAt = maxDate(
      issue.updatedAt,
      issueActivityById.get(issue.id),
      workProductMovementByIssueId.get(issue.id),
      documentMovementByIssueId.get(issue.id),
    ) ?? issue.updatedAt;
    issueMovementAt.set(issue.id, movementAt);
    if (movementAt >= windowStart) recentMovementIssueIds.add(issue.id);
  }

  const outputs: BoardBriefOutput[] = [
    ...(recentWorkProductRows as WorkProductRow[]).map((row) => ({
      id: row.id,
      kind: "work_product" as const,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier ?? null,
      issueTitle: row.issueTitle,
      projectId: row.projectId ?? null,
      title: row.title,
      subtitle: row.summary ?? null,
      url: row.url ?? null,
      outputType: row.type,
      status: row.status,
      reviewState: row.reviewState,
      updatedAt: row.updatedAt,
    })),
    ...(recentDocumentRevisionRows as DocumentRevisionRow[]).map((row) => ({
      id: row.id,
      kind: "document_revision" as const,
      issueId: row.issueId,
      issueIdentifier: row.issueIdentifier ?? null,
      issueTitle: row.issueTitle,
      projectId: row.projectId ?? null,
      title: row.revisionTitle ?? row.documentTitle ?? "Document revision",
      subtitle: row.changeSummary ?? null,
      url: `/issues/${row.issueIdentifier ?? row.issueId}`,
      outputType: "document",
      status: null,
      reviewState: null,
      updatedAt: row.createdAt,
    })),
  ]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const focusAreaBuckets = new Map<string, FocusAreaBucket>();
  for (const issue of openIssueRows) {
    const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
    bucket.memberIssueIds.add(issue.id);
    if (issue.status === "blocked") bucket.blockedCount += 1;
    if (issue.assigneeAgentId) bucket.activeAgentIds.add(issue.assigneeAgentId);
    if (issue.updatedAt > bucket.latestAt) {
      bucket.latestAt = issue.updatedAt;
      bucket.latestUpdate = issue.title;
    }
  }

  for (const issueId of recentMovementIssueIds) {
    const issue = issueById.get(issueId);
    if (!issue) continue;
    const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
    bucket.changedIssueIds.add(issueId);
    const movementAt = issueMovementAt.get(issueId) ?? issue.updatedAt;
    if (movementAt > bucket.latestAt) {
      bucket.latestAt = movementAt;
      bucket.latestUpdate = issue.title;
    }
  }

  for (const output of outputs) {
    const issue = issueById.get(output.issueId);
    if (!issue) continue;
    const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
    bucket.outputCount += 1;
    bucket.changedIssueIds.add(output.issueId);
    if (output.updatedAt > bucket.latestAt) {
      bucket.latestAt = output.updatedAt;
      bucket.latestUpdate = output.title;
    }
  }

  const latestRunByAgentId = new Map<string, LatestRunRow>();
  for (const row of latestRunRows as LatestRunRow[]) latestRunByAgentId.set(row.agentId, row);

  const failedRuns = (recentFailedRunRows as LatestRunRow[])
    .filter((row) => FAILED_RUN_STATUSES.has(row.status))
    .filter((row) => {
      const linkedId = linkedIssueId(row.contextSnapshot);
      return linkedId ? issueById.has(linkedId) : row.agentStatus !== "paused";
    });

  for (const run of failedRuns) {
    const linkedId = linkedIssueId(run.contextSnapshot);
    if (!linkedId) continue;
    const issue = issueById.get(linkedId);
    if (!issue) continue;
    const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
    bucket.failedRunCount += 1;
    if (run.createdAt > bucket.latestAt) {
      bucket.latestAt = run.createdAt;
      bucket.latestUpdate = `${run.agentName ?? "Agent"} failed`;
    }
  }

  for (const approval of approvalRows as ApprovalRow[]) {
    const linkedId = linkedApprovalIssueId(approval.payload);
    if (linkedId && issueById.has(linkedId)) {
      const bucket = ensureFocusArea(focusAreaBuckets, issueById.get(linkedId)!, issueById);
      if (approval.updatedAt > bucket.latestAt) {
        bucket.latestAt = approval.updatedAt;
        bucket.latestUpdate = approvalTitle(approval);
      }
      continue;
    }

    const projectId = linkedProjectId(approval.payload);
    if (!projectId) continue;
    const issue = openIssueRows.find((row) => row.projectId === projectId);
    if (!issue) continue;
    const bucket = ensureFocusArea(focusAreaBuckets, issue, issueById);
    if (approval.updatedAt > bucket.latestAt) {
      bucket.latestAt = approval.updatedAt;
      bucket.latestUpdate = approvalTitle(approval);
    }
  }

  const incidents: BoardBriefIncident[] = [];
  const actionQueue: BoardBriefActionItem[] = [];

  for (const incident of budgetOverview.activeIncidents) {
    const severity = incident.thresholdType === "hard" ? "critical" : "high";
    incidents.push({
      fingerprint: `budget_incident:${incident.id}`,
      type: "budget_incident",
      severity,
      entityType: incident.scopeType,
      entityId: incident.scopeId,
      title: `Budget incident: ${incident.scopeName}`,
      reason: `${incident.scopeName} is over ${humanizeToken(incident.thresholdType)} threshold`,
      openedAt: incident.createdAt,
      lastSeenAt: incident.updatedAt,
      shouldAlert: true,
    });
    actionQueue.push({
      key: `budget:${incident.id}`,
      kind: "budget",
      entityId: incident.id,
      title: `Budget incident: ${incident.scopeName}`,
      reason: `${humanizeToken(incident.thresholdType)} threshold reached`,
      severity,
      timestamp: incident.updatedAt,
      href: "/costs",
      ctaLabel: "Review budget",
    });
  }

  const boardOwnedIssueCount = openIssueRows.filter((issue) => issue.assigneeUserId).length;
  const issueActionItems: BoardBriefActionItem[] = [];
  const outputActionItems: BoardBriefActionItem[] = [];

  for (const issue of openIssueRows) {
    const movementAt = issueMovementAt.get(issue.id) ?? issue.updatedAt;
    const ageMs = now.getTime() - movementAt.getTime();
    const issueLabel = issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;

    let issueActionItem: BoardBriefActionItem | null = null;

    if (issue.status === "blocked" && ageMs >= STALE_BLOCKED_ISSUE_AT_RISK_MS) {
      const severity = ageMs >= STALE_BLOCKED_ISSUE_BLOCKED_MS ? "critical" : "high";
      incidents.push({
        fingerprint: `blocked_issue_aging:${issue.id}`,
        type: "blocked_issue_aging",
        severity,
        entityType: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: severity === "critical" ? "Blocked issue aged past 8 hours" : "Blocked issue aged past 4 hours",
        openedAt: movementAt,
        lastSeenAt: now,
        shouldAlert: severity === "critical",
      });
      issueActionItem = {
        key: `issue:block:${issue.id}`,
        kind: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: severity === "critical" ? "Blocked for over 8 hours" : "Blocked for over 4 hours",
        severity,
        timestamp: movementAt,
        href: `/issues/${issue.identifier ?? issue.id}`,
        ctaLabel: "Open issue",
      };
    } else if (issue.assigneeAgentId && ageMs >= STALE_OPEN_ASSIGNED_ISSUE_MS) {
      incidents.push({
        fingerprint: `stale_issue:${issue.id}`,
        type: "stale_issue",
        severity: "high",
        entityType: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: "Open assigned issue has no meaningful movement for 24 hours",
        openedAt: movementAt,
        lastSeenAt: now,
        shouldAlert: true,
      });
      issueActionItem = {
        key: `issue:stale:${issue.id}`,
        kind: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: "No meaningful movement in the last 24 hours",
        severity: "high",
        timestamp: movementAt,
        href: `/issues/${issue.identifier ?? issue.id}`,
        ctaLabel: "Open issue",
      };
    } else if (issue.assigneeUserId) {
      issueActionItem = {
        key: `issue:board:${issue.id}`,
        kind: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: "Waiting on board action",
        severity: "high",
        timestamp: movementAt,
        href: `/issues/${issue.identifier ?? issue.id}`,
        ctaLabel: "Open issue",
      };
    } else if (!issue.assigneeAgentId && !issue.assigneeUserId && recentMovementIssueIds.has(issue.id)) {
      issueActionItem = {
        key: `issue:routing:${issue.id}`,
        kind: "issue",
        entityId: issue.id,
        title: issueLabel,
        reason: "Needs routing",
        severity: "medium",
        timestamp: movementAt,
        href: `/issues/${issue.identifier ?? issue.id}`,
        ctaLabel: "Open issue",
      };
    }

    if (issueActionItem) issueActionItems.push(issueActionItem);
  }

  for (const output of outputs) {
    if (output.kind !== "work_product") continue;
    if (output.reviewState !== "needs_board_review" && output.status !== "ready_for_review") continue;
    outputActionItems.push({
      key: `output:${output.id}`,
      kind: "output",
      entityId: output.id,
      title: output.title,
      reason: output.reviewState === "needs_board_review" ? "Needs board review" : "Ready for review",
      severity: "high",
      timestamp: output.updatedAt,
      href: output.url ?? `/issues/${output.issueIdentifier ?? output.issueId}`,
      ctaLabel: "Review output",
    });
  }

  const approvalActionItems: BoardBriefActionItem[] = (approvalRows as ApprovalRow[]).map((approval) => {
    const ageMs = now.getTime() - approval.updatedAt.getTime();
    if (ageMs >= AGING_APPROVAL_WATCH_MS) {
      incidents.push({
        fingerprint: `approval_aging:${approval.id}`,
        type: "approval_aging",
        severity: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "high" : "medium",
        entityType: "approval",
        entityId: approval.id,
        title: approvalTitle(approval),
        reason: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "Approval aged past 24 hours" : "Approval aged past 12 hours",
        openedAt: approval.createdAt,
        lastSeenAt: approval.updatedAt,
        shouldAlert: ageMs >= AGING_APPROVAL_AT_RISK_MS,
      });
    }

    return {
      key: `approval:${approval.id}`,
      kind: "approval",
      entityId: approval.id,
      title: approvalTitle(approval),
      reason: approval.status === "revision_requested" ? "Revision requested before approval" : "Pending board approval",
      severity: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "high" : approval.status === "revision_requested" ? "high" : "medium",
      timestamp: approval.updatedAt,
      href: `/approvals/${approval.id}`,
      ctaLabel: "Review approval",
    };
  });

  const joinRequestActionItems: BoardBriefActionItem[] = (joinRequestRows as JoinRequestRow[]).map((joinRequest) => {
    const ageMs = now.getTime() - joinRequest.updatedAt.getTime();
    if (ageMs >= AGING_APPROVAL_WATCH_MS) {
      incidents.push({
        fingerprint: `join_request_aging:${joinRequest.id}`,
        type: "join_request_aging",
        severity: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "high" : "medium",
        entityType: "join_request",
        entityId: joinRequest.id,
        title: joinRequestTitle(joinRequest),
        reason: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "Join request aged past 24 hours" : "Join request aged past 12 hours",
        openedAt: joinRequest.createdAt,
        lastSeenAt: joinRequest.updatedAt,
        shouldAlert: ageMs >= AGING_APPROVAL_AT_RISK_MS,
      });
    }

    return {
      key: `join_request:${joinRequest.id}`,
      kind: "join_request",
      entityId: joinRequest.id,
      title: joinRequestTitle(joinRequest),
      reason: "Pending join request",
      severity: ageMs >= AGING_APPROVAL_AT_RISK_MS ? "high" : "medium",
      timestamp: joinRequest.updatedAt,
      href: "/inbox/unread",
      ctaLabel: "Review request",
    };
  });

  const failedRunActionItems = failedRuns.map((run) => {
    const linkedId = linkedIssueId(run.contextSnapshot);
    const linkedIssue = linkedId ? issueById.get(linkedId) ?? null : null;
    const issueRef = linkedIssue?.identifier ?? linkedIssue?.id;
    return {
      key: `run:${run.id}`,
      kind: "run" as const,
      entityId: run.id,
      title: issueRef
        ? `${run.agentName ?? run.agentId} failed on ${issueRef} ${linkedIssue?.title ?? ""}`.trim()
        : `${run.agentName ?? run.agentId} failed`,
      reason: "Failed active run",
      severity: "high" as const,
      timestamp: maxDate(run.finishedAt, run.startedAt, run.createdAt) ?? run.createdAt,
      href: `/agents/${run.agentId}/runs/${run.id}`,
      ctaLabel: "Inspect failure",
    };
  });

  const failedRunsAtRisk = failedRuns.filter((run) =>
    (maxDate(run.finishedAt, run.startedAt, run.createdAt) ?? run.createdAt).getTime() >= now.getTime() - FAILED_RUN_SPIKE_AT_RISK_WINDOW_MS
  );
  const failedRunsBlocked = failedRuns.filter((run) =>
    (maxDate(run.finishedAt, run.startedAt, run.createdAt) ?? run.createdAt).getTime() >= now.getTime() - FAILED_RUN_SPIKE_BLOCKED_WINDOW_MS
  );
  const distinctFailedAtRiskAgents = new Set(failedRunsAtRisk.map((run) => run.agentId));
  const distinctFailedBlockedAgents = new Set(failedRunsBlocked.map((run) => run.agentId));

  if (distinctFailedBlockedAgents.size >= 3) {
    incidents.push({
      fingerprint: "failed_run_spike:company",
      type: "failed_run_spike",
      severity: "critical",
      entityType: "company",
      entityId: companyId,
      title: "Failed run spike",
      reason: "3 or more agents failed within the last hour",
      openedAt: now,
      lastSeenAt: now,
      shouldAlert: true,
    });
  } else if (distinctFailedAtRiskAgents.size >= 2) {
    incidents.push({
      fingerprint: "failed_run_spike:company",
      type: "failed_run_spike",
      severity: "high",
      entityType: "company",
      entityId: companyId,
      title: "Failed run spike",
      reason: "2 or more agents failed within the last 6 hours",
      openedAt: now,
      lastSeenAt: now,
      shouldAlert: true,
    });
  }

  const staleAgentActionItems: BoardBriefActionItem[] = [];
  for (const agent of agentRows as AgentRow[]) {
    if (agent.status === "paused") continue;
    const policy = parseSchedulerHeartbeatPolicy(agent.runtimeConfig);
    const latestRun = latestRunByAgentId.get(agent.id);
    const latestRunAt = latestRun ? maxDate(latestRun.finishedAt, latestRun.startedAt, latestRun.createdAt) : null;
    const assignedOpenIssues = openIssueRows.filter((issue) => issue.assigneeAgentId === agent.id);
    const lastAssignedIssueMovementAt = assignedOpenIssues
      .map((issue) => issueMovementAt.get(issue.id) ?? issue.updatedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const latestActivityAt = maxDate(
      agent.lastHeartbeatAt,
      latestRunAt,
      agentActivityById.get(agent.id),
      lastAssignedIssueMovementAt,
      agent.updatedAt,
    );

    let isStale = false;
    if (policy.enabled) {
      const thresholdMs = Math.max(policy.intervalSec * 1000 * 3, 30 * 60 * 1000);
      isStale = !agent.lastHeartbeatAt || agent.lastHeartbeatAt.getTime() < now.getTime() - thresholdMs;
    } else if (assignedOpenIssues.length > 0) {
      isStale = !latestActivityAt || latestActivityAt.getTime() < now.getTime() - STALE_NON_SCHEDULER_AGENT_MS;
    }

    if (!isStale) continue;

    const lastSeenAt = latestActivityAt ?? agent.updatedAt;
    incidents.push({
      fingerprint: `stale_agent:${agent.id}`,
      type: "stale_agent",
      severity: "high",
      entityType: "agent",
      entityId: agent.id,
      title: agent.name,
      reason: policy.enabled
        ? "Scheduler-active agent heartbeat is stale"
        : "Agent with active work has no run, activity, or output in 24 hours",
      openedAt: lastSeenAt,
      lastSeenAt: now,
      shouldAlert: true,
    });
    staleAgentActionItems.push({
      key: `agent:${agent.id}`,
      kind: "agent",
      entityId: agent.id,
      title: agent.name,
      reason: policy.enabled
        ? "Scheduler heartbeat is stale"
        : "Assigned work is stale with no recent execution",
      severity: "high",
      timestamp: lastSeenAt,
      href: `/agents/${agent.id}`,
      ctaLabel: "Inspect agent",
    });
  }

  const latestFinishedRunAt = (latestRunRows as LatestRunRow[])
    .map((row) => maxDate(row.finishedAt, row.startedAt, row.createdAt))
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const latestCostEventAtRaw = latestCostEventRows[0]?.occurredAt ?? null;
  const latestCostEventAt = latestCostEventAtRaw ? new Date(latestCostEventAtRaw) : null;
  const costTelemetryStale =
    latestFinishedRunAt !== null
    && latestFinishedRunAt.getTime() >= now.getTime() - COST_FRESHNESS_RUN_WINDOW_MS
    && (!latestCostEventAt || latestCostEventAt.getTime() < latestFinishedRunAt.getTime() - COST_FRESHNESS_LAG_MS);
  if (costTelemetryStale) {
    incidents.push({
      fingerprint: "cost_telemetry_stale:company",
      type: "cost_telemetry_stale",
      severity: "high",
      entityType: "company",
      entityId: companyId,
      title: company.name,
      reason: "Recent finished runs are ahead of cost telemetry by more than 30 minutes",
      openedAt: latestFinishedRunAt,
      lastSeenAt: now,
      shouldAlert: true,
    });
  }

  actionQueue.push(
    ...approvalActionItems,
    ...joinRequestActionItems,
    ...outputActionItems,
    ...failedRunActionItems,
    ...staleAgentActionItems,
    ...issueActionItems,
  );

  const uniqueActionQueue = Array.from(new Map(actionQueue.map((item) => [item.key, item])).values())
    .sort((left, right) => {
      const priorityDiff = actionPriority(left.kind) - actionPriority(right.kind);
      if (priorityDiff !== 0) return priorityDiff;
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) return severityDiff;
      return right.timestamp.getTime() - left.timestamp.getTime();
    });

  const uniqueIncidents = Array.from(new Map(incidents.map((incident) => [incident.fingerprint, incident])).values())
    .sort((left, right) => {
      const severityDiff = severityRank(right.severity) - severityRank(left.severity);
      if (severityDiff !== 0) return severityDiff;
      return right.lastSeenAt.getTime() - left.lastSeenAt.getTime();
    });

  const focusAreas: BoardBriefFocusArea[] = Array.from(focusAreaBuckets.values())
    .filter((bucket) => bucket.changedIssueIds.size > 0 || bucket.failedRunCount > 0 || bucket.outputCount > 0)
    .map((bucket) => {
      const tone: BoardBrief["health"]["tone"] =
        bucket.blockedCount > 0
          ? "blocked"
          : bucket.failedRunCount > 0
            ? "at_risk"
            : bucket.changedIssueIds.size >= 3
              ? "watch"
              : "healthy";

      return {
        key: bucket.key,
        label: bucket.label,
        tone,
        changedIssueCount: bucket.changedIssueIds.size,
        blockedCount: bucket.blockedCount,
        failedRunCount: bucket.failedRunCount,
        activeAgentCount: bucket.activeAgentIds.size,
        outputCount: bucket.outputCount,
        latestUpdate: bucket.latestUpdate,
        href: bucket.href,
      };
    })
    .sort((left, right) => {
      const toneDiff = toneRank(right.tone) - toneRank(left.tone);
      if (toneDiff !== 0) return toneDiff;
      return right.changedIssueCount - left.changedIssueCount;
    })
    .slice(0, 5);

  const agentCounts = { active: 0, running: 0, paused: 0, error: 0 };
  for (const row of agentRows as AgentRow[]) {
    const bucket = row.status === "idle" ? "active" : row.status;
    if (bucket in agentCounts) {
      agentCounts[bucket as keyof typeof agentCounts] += 1;
    }
  }

  const taskCounts = { open: 0, inProgress: 0, blocked: 0, done: 0 };
  for (const row of taskRows as Array<{ status: string; count: number }>) {
    const count = Number(row.count ?? 0);
    if (row.status === "in_progress") taskCounts.inProgress += count;
    if (row.status === "blocked") taskCounts.blocked += count;
    if (row.status === "done") taskCounts.done += count;
    if (row.status !== "done" && row.status !== "cancelled" && row.status !== "terminated") taskCounts.open += count;
  }

  const decisionsCount = approvalRows.length + joinRequestRows.length + boardOwnedIssueCount + outputActionItems.length;

  const freshness: BoardBrief["freshness"] = {
    execution: {
      status: uniqueIncidents.some((incident) => incident.type === "stale_agent") ? "stale" : (agentRows as AgentRow[]).length > 0 ? "fresh" : "unknown",
      lastUpdatedAt: maxDate(
        ...(agentRows as AgentRow[]).map((row) => row.lastHeartbeatAt ?? row.updatedAt),
        ...(latestRunRows as LatestRunRow[]).map((row) => maxDate(row.finishedAt, row.startedAt, row.createdAt)),
      ),
      reason: uniqueIncidents.some((incident) => incident.type === "stale_agent")
        ? "One or more scheduler-active agents are stale"
        : null,
    },
    work: {
      status: uniqueIncidents.some((incident) => incident.type === "stale_issue" || incident.type === "blocked_issue_aging")
        ? "stale"
        : openIssueRows.length > 0
          ? "fresh"
          : "unknown",
      lastUpdatedAt: maxDate(...openIssueRows.map((issue) => issueMovementAt.get(issue.id) ?? issue.updatedAt)),
      reason: uniqueIncidents.some((incident) => incident.type === "stale_issue")
        ? "Assigned work is stalled"
        : uniqueIncidents.some((incident) => incident.type === "blocked_issue_aging")
          ? "Blocked work is aging"
          : null,
    },
    cost: {
      status: costTelemetryStale ? "stale" : latestCostEventAt ? "fresh" : "unknown",
      lastUpdatedAt: latestCostEventAt,
      reason: costTelemetryStale ? "Cost telemetry lags behind recent finished runs" : null,
    },
    approvals: {
      status: uniqueIncidents.some((incident) => incident.type === "approval_aging" || incident.type === "join_request_aging")
        ? "stale"
        : approvalRows.length > 0 || joinRequestRows.length > 0
          ? "fresh"
          : "unknown",
      lastUpdatedAt: maxDate(
        ...(approvalRows as ApprovalRow[]).map((row) => row.updatedAt),
        ...(joinRequestRows as JoinRequestRow[]).map((row) => row.updatedAt),
      ),
      reason: uniqueIncidents.some((incident) => incident.type === "approval_aging" || incident.type === "join_request_aging")
        ? "Pending decisions are aging"
        : null,
    },
    outputs: {
      status: outputs.length > 0 ? "fresh" : openIssueRows.length > 0 ? "stale" : "unknown",
      lastUpdatedAt: outputs[0]?.updatedAt ?? null,
      reason: outputs.length === 0 && openIssueRows.length > 0 ? "No fresh work products or document revisions in the last 24 hours" : null,
    },
  };

  const confidence = buildConfidence(freshness);
  const highestIncidentSeverity = uniqueIncidents[0]?.severity ?? null;
  const healthTone: BoardBrief["health"]["tone"] =
    highestIncidentSeverity === "critical" || budgetOverview.activeIncidents.length > 0
      ? "blocked"
      : highestIncidentSeverity === "high" || agentCounts.error > 0 || utilization >= 90
        ? "at_risk"
        : highestIncidentSeverity === "medium" || decisionsCount > 0 || utilization >= 80
          ? "watch"
          : "healthy";

  const healthReasons = uniqueIncidents.slice(0, 4).map((incident) => incident.reason);
  if (healthReasons.length === 0) {
    if (decisionsCount > 0) healthReasons.push("Board decisions are waiting");
    else healthReasons.push("No blocking incidents or stale telemetry");
  }

  const brief: BoardBrief = {
    meta: {
      companyId,
      schemaVersion: SCHEMA_VERSION,
      generatedAt: now,
      windowStart,
      windowEnd: now,
    },
    totals: {
      agents: agentCounts,
      tasks: taskCounts,
      costs: {
        monthSpendCents,
        monthBudgetCents: company.budgetMonthlyCents,
        monthUtilizationPercent: utilization,
      },
      budgets: {
        activeIncidents: budgetOverview.activeIncidents.length,
        pendingApprovals: budgetOverview.pendingApprovalCount,
        pausedAgents: budgetOverview.pausedAgentCount,
        pausedProjects: budgetOverview.pausedProjectCount,
      },
      pendingApprovals,
    },
    health: {
      tone: healthTone,
      reasons: healthReasons,
    },
    freshness,
    confidence,
    snapshot: {
      progress: {
        value: String(taskCounts.inProgress),
        label: "In flight",
        headline:
          taskCounts.inProgress > 0
            ? "Work is moving"
            : taskCounts.open > 0
              ? "Work is queued but not yet moving"
              : "No active work in flight",
        detail: `${pluralize(completedRecently, "issue")} completed in the last 24 hours`,
        tone: taskCounts.inProgress > 0 ? "healthy" : taskCounts.open > 0 ? "watch" : "healthy",
      },
      risk: {
        value: String(taskCounts.blocked),
        label: "Blocked",
        headline:
          taskCounts.blocked > 0
            ? "Blocked work needs intervention"
            : failedRuns.length > 0
              ? "Execution reliability needs attention"
              : "No critical execution risk right now",
        detail: `${pluralize(failedRuns.length, "failed run")} on active work`,
        tone: taskCounts.blocked > 0 ? "blocked" : failedRuns.length > 0 ? "at_risk" : "healthy",
      },
      decisions: {
        value: String(decisionsCount),
        label: "Waiting",
        headline: decisionsCount > 0 ? "Board input required" : "No board decisions waiting",
        detail: `${pluralize(approvalRows.length, "approval")}, ${pluralize(joinRequestRows.length, "join request")}, ${pluralize(outputActionItems.length, "output review")}`,
        tone: decisionsCount > 0 ? "watch" : "healthy",
      },
      spend: {
        value: formatUsdCents(monthSpendCents),
        label: "Month spend",
        headline:
          company.budgetMonthlyCents > 0
            ? utilization >= 100
              ? "Budget limit reached"
              : utilization >= 80
                ? "Budget is getting tight"
                : "Budget is under control"
            : "No monthly budget cap",
        detail:
          company.budgetMonthlyCents > 0
            ? `${utilization}% of ${formatUsdCents(company.budgetMonthlyCents)} budget`
            : "Unlimited budget",
        tone:
          budgetOverview.activeIncidents.length > 0
            ? "blocked"
            : utilization >= 90
              ? "at_risk"
              : utilization >= 80
                ? "watch"
                : "healthy",
      },
      outputs: computeOutputsMetric(outputs),
    },
    focusAreas,
    actionQueue: uniqueActionQueue,
    incidents: uniqueIncidents,
    outputs,
    manualKpis,
  };

  const issueTransitionsRaw: Array<{
    issueId: string;
    toStatus: string;
    fromStatus: string | null;
    updatedAt: Date;
  }> = [];
  const seenIssueIds = new Set<string>();
  for (const row of transitionRows as TransitionActivityRow[]) {
    if (issueTransitionsRaw.length >= 5) break;
    const details = row.details ?? null;
    const toStatus = typeof details?.status === "string" ? details.status : null;
    if (!toStatus || !ISSUE_TRANSITION_TARGET_STATUSES.has(toStatus) || seenIssueIds.has(row.issueId)) continue;
    const previous = details?._previous;
    const fromStatus =
      previous && typeof previous === "object" && typeof (previous as Record<string, unknown>).status === "string"
        ? (previous as Record<string, unknown>).status as string
        : null;
    issueTransitionsRaw.push({
      issueId: row.issueId,
      toStatus,
      fromStatus,
      updatedAt: row.updatedAt,
    });
    seenIssueIds.add(row.issueId);
  }

  const issueMetaById = new Map(allIssueRows.map((issue) => [issue.id, issue]));
  const topChanges: ExecutiveSummaryTopChanges = {
    issueTransitions: issueTransitionsRaw.map((row): ExecutiveSummaryIssueTransition => {
      const meta = issueMetaById.get(row.issueId);
      return {
        issueId: row.issueId,
        issueIdentifier: meta?.identifier ?? null,
        issueTitle: meta?.title ?? row.issueId,
        fromStatus: row.fromStatus as ExecutiveSummaryIssueTransition["fromStatus"],
        toStatus: row.toStatus as ExecutiveSummaryIssueTransition["toStatus"],
        updatedAt: row.updatedAt,
      };
    }),
    failedRuns: failedRuns.slice(0, 3).map((run): ExecutiveSummaryFailedRun => ({
      runId: run.id,
      agentId: run.agentId,
      agentName: run.agentName ?? null,
      status: run.status as ExecutiveSummaryFailedRun["status"],
      error: run.error ? truncate(run.error) : null,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
    })),
    pendingApprovals,
  };

  return {
    brief,
    company,
    recipients,
    topChanges,
  };
}

function toDashboardAttentionItem(item: BoardBriefActionItem): DashboardAttentionItem | null {
  if (
    item.kind !== "issue"
    && item.kind !== "run"
    && item.kind !== "approval"
    && item.kind !== "join_request"
    && item.kind !== "output"
  ) {
    return null;
  }
  return {
    key: item.key,
    kind: item.kind,
    entityId: item.entityId,
    title: item.title,
    reason: item.reason,
    severity: item.severity,
    timestamp: item.timestamp,
    href: item.href,
    ctaLabel: item.ctaLabel,
  };
}

export function boardBriefService(db: Db) {
  return {
    build: async (companyId: string, now: Date = new Date(), database: Db | any = db): Promise<BoardBrief> => {
      const context = await buildContext(companyId, now, database);
      return context.brief;
    },

    buildDashboardSummary: async (companyId: string, now: Date = new Date(), database: Db | any = db) => {
      const context = await buildContext(companyId, now, database);
      const dashboardAttentionItems = context.brief.actionQueue
        .map(toDashboardAttentionItem)
        .filter((item): item is DashboardAttentionItem => item !== null);
      const displayedAttentionItems = dashboardAttentionItems.slice(0, 7);
      const failedRuns = dashboardAttentionItems.filter((item) => item.kind === "run").length;
      const decisions = dashboardAttentionItems.filter((item) =>
        item.kind === "approval" || item.kind === "join_request" || item.reason === "Waiting on board action"
      ).length;
      return {
        companyId: context.brief.meta.companyId,
        agents: context.brief.totals.agents,
        tasks: context.brief.totals.tasks,
        costs: context.brief.totals.costs,
        pendingApprovals: context.brief.totals.pendingApprovals,
        budgets: context.brief.totals.budgets,
        brief: {
          health: resolveLegacyDashboardHealth({
            blockedIssues: context.brief.totals.tasks.blocked,
            failedRuns,
            activeBudgetIncidents: context.brief.totals.budgets.activeIncidents,
            decisions,
            agentErrors: context.brief.totals.agents.error,
            utilizationPercent: context.brief.totals.costs.monthUtilizationPercent,
          }),
          snapshot: {
            progress: context.brief.snapshot.progress,
            risk: context.brief.snapshot.risk,
            decisions: context.brief.snapshot.decisions,
            spend: context.brief.snapshot.spend,
          },
          focusAreas: context.brief.focusAreas.map((area) => ({
            key: area.key,
            label: area.label,
            tone: area.tone,
            changedIssueCount: area.changedIssueCount,
            blockedCount: area.blockedCount,
            failedRunCount: area.failedRunCount,
            activeAgentCount: area.activeAgentCount,
            latestUpdate: area.latestUpdate,
            href: area.href,
          })),
          needsAttention: displayedAttentionItems,
        },
      } satisfies DashboardSummary;
    },

    buildExecutiveSummary: async (companyId: string, now: Date = new Date(), database: Db | any = db): Promise<ExecutiveSummary> => {
      const context = await buildContext(companyId, now, database);
      return {
        companyId: context.company.id,
        companyName: context.company.name,
        generatedAt: context.brief.meta.generatedAt,
        periodStart: context.brief.meta.windowStart,
        periodEnd: context.brief.meta.windowEnd,
        manualKpis: context.brief.manualKpis,
        computedKpis: {
          monthSpendCents: context.brief.totals.costs.monthSpendCents,
          monthBudgetCents: context.brief.totals.costs.monthBudgetCents,
          monthUtilizationPercent: context.brief.totals.costs.monthUtilizationPercent,
          tasksOpen: context.brief.totals.tasks.open,
          tasksInProgress: context.brief.totals.tasks.inProgress,
          tasksBlocked: context.brief.totals.tasks.blocked,
          tasksDone: context.brief.totals.tasks.done,
          pendingApprovals: context.brief.totals.pendingApprovals,
          activeBudgetIncidents: context.brief.totals.budgets.activeIncidents,
          pausedAgents: context.brief.totals.budgets.pausedAgents,
          pausedProjects: context.brief.totals.budgets.pausedProjects,
        },
        topChanges: context.topChanges,
        dispatch: {
          enabled: context.company.dailyExecutiveSummaryEnabled,
          lastSentAt: context.company.dailyExecutiveSummaryLastSentAt,
          lastStatus: mapExecutiveSummaryStatus(context.company.dailyExecutiveSummaryLastStatus),
          lastError: context.company.dailyExecutiveSummaryLastError,
          recipients: context.recipients,
        },
      };
    },

    listHistory: async (
      companyId: string,
      options: { limit?: number; source?: BoardBriefSnapshot["source"] } = {},
      database: Db | any = db,
    ): Promise<BoardBriefSnapshot[]> => {
      const limit = Math.min(Math.max(options.limit ?? 30, 1), 100);
      const rows = await database
        .select()
        .from(boardBriefSnapshots)
        .where(
          options.source
            ? and(eq(boardBriefSnapshots.companyId, companyId), eq(boardBriefSnapshots.source, options.source))
            : eq(boardBriefSnapshots.companyId, companyId),
        )
        .orderBy(desc(boardBriefSnapshots.generatedAt))
        .limit(limit);

      return rows.map((row: typeof boardBriefSnapshots.$inferSelect) => boardBriefSnapshotSchema.parse({
        id: row.id,
        companyId: row.companyId,
        source: row.source,
        schemaVersion: row.schemaVersion,
        health: row.health,
        confidence: row.confidence,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        generatedAt: row.generatedAt,
        relatedAlertEventId: row.relatedAlertEventId,
        payload: row.payload,
        createdAt: row.createdAt,
      }));
    },
  };
}
