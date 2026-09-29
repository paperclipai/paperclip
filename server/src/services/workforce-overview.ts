import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  companyMemberships,
  environments,
  heartbeatRuns,
  issueLabels,
  issueRelations,
  issueWorkProducts,
  issues,
  labels,
  projects,
} from "@paperclipai/db";
import {
  WORKFORCE_OVERVIEW_LIMITS,
  defaultWorkforceInitiative,
  projectWorkforceOverview,
  type WorkforceActivityInput,
  type WorkforceAgentInput,
  type WorkforceApprovalInput,
  type WorkforceIssueInput,
  type WorkforceOverviewSnapshot,
  type WorkforceProjectInput,
  type WorkforceRunInput,
  type WorkforceWorkProductInput,
} from "@paperclipai/shared/workforce-overview";
import { notFound } from "../errors.js";
import { executionIssueCondition } from "./issue-visibility.js";

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Company-scoped read model for the live workforce overview.
 * Every query is a select. This service does not check out, resume, assign,
 * or start work.
 */
export function workforceOverviewService(db: Db) {
  return {
    get: async (companyId: string, initiativeQuery: string | null) => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const now = new Date();
      const runCutoff = new Date(now.getTime() - RUN_LOOKBACK_MS);

      const [
        agentRows,
        environmentRows,
        projectRows,
        issueRows,
        relationRows,
        labelRows,
        approvalRows,
        runRows,
        activityRows,
        workProductRows,
        memberRows,
      ] = await Promise.all([
        db
          .select({
            id: agents.id,
            name: agents.name,
            role: agents.role,
            title: agents.title,
            status: agents.status,
            reportsTo: agents.reportsTo,
            adapterType: agents.adapterType,
            adapterConfig: agents.adapterConfig,
            defaultEnvironmentId: agents.defaultEnvironmentId,
            pauseReason: agents.pauseReason,
            pausedAt: agents.pausedAt,
            errorReason: agents.errorReason,
            lastHeartbeatAt: agents.lastHeartbeatAt,
          })
          .from(agents)
          .where(eq(agents.companyId, companyId)),
        db.select({ id: environments.id, name: environments.name }).from(environments),
        db
          .select({
            id: projects.id,
            name: projects.name,
            status: projects.status,
            leadAgentId: projects.leadAgentId,
            pauseReason: projects.pauseReason,
            pausedAt: projects.pausedAt,
            archivedAt: projects.archivedAt,
            updatedAt: projects.updatedAt,
          })
          .from(projects)
          .where(eq(projects.companyId, companyId)),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            projectId: issues.projectId,
            parentId: issues.parentId,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            priority: issues.priority,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
            executionState: issues.executionState,
            unblockDescriptor: issues.unblockDescriptor,
            completedAt: issues.completedAt,
            updatedAt: issues.updatedAt,
            monitorNextCheckAt: issues.monitorNextCheckAt,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), executionIssueCondition(), ne(issues.status, "cancelled")))
          .orderBy(sql`case when ${issues.status} = 'done' then 1 else 0 end`, desc(issues.updatedAt))
          .limit(WORKFORCE_OVERVIEW_LIMITS.issues),
        db
          .select({
            blockerIssueId: issueRelations.issueId,
            blockedIssueId: issueRelations.relatedIssueId,
          })
          .from(issueRelations)
          .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
        db
          .select({ issueId: issueLabels.issueId, name: labels.name })
          .from(issueLabels)
          .innerJoin(labels, eq(labels.id, issueLabels.labelId))
          .where(eq(issueLabels.companyId, companyId)),
        db
          .select({
            id: approvals.id,
            type: approvals.type,
            status: approvals.status,
            payload: approvals.payload,
            createdAt: approvals.createdAt,
          })
          .from(approvals)
          .where(eq(approvals.companyId, companyId)),
        db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            error: heartbeatRuns.error,
            errorCode: heartbeatRuns.errorCode,
            livenessReason: heartbeatRuns.livenessReason,
            nextAction: heartbeatRuns.nextAction,
            scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
            nativeIssueId: heartbeatRuns.nativeIssueId,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            startedAt: heartbeatRuns.startedAt,
            finishedAt: heartbeatRuns.finishedAt,
            updatedAt: heartbeatRuns.updatedAt,
            createdAt: heartbeatRuns.createdAt,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, companyId),
              or(
                inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES]),
                gte(heartbeatRuns.createdAt, runCutoff),
              ),
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(WORKFORCE_OVERVIEW_LIMITS.runs),
        db
          .select({
            id: activityLog.id,
            actorType: activityLog.actorType,
            actorId: activityLog.actorId,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            agentId: activityLog.agentId,
            runId: activityLog.runId,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(eq(activityLog.companyId, companyId))
          .orderBy(desc(activityLog.createdAt))
          .limit(WORKFORCE_OVERVIEW_LIMITS.activity),
        db
          .select({
            id: issueWorkProducts.id,
            issueId: issueWorkProducts.issueId,
            projectId: issueWorkProducts.projectId,
            type: issueWorkProducts.type,
            title: issueWorkProducts.title,
            url: issueWorkProducts.url,
            status: issueWorkProducts.status,
            reviewState: issueWorkProducts.reviewState,
            metadata: issueWorkProducts.metadata,
            updatedAt: issueWorkProducts.updatedAt,
          })
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.companyId, companyId))
          .orderBy(desc(issueWorkProducts.updatedAt))
          .limit(WORKFORCE_OVERVIEW_LIMITS.workProducts),
        db
          .select({
            userId: companyMemberships.principalId,
            name: authUsers.name,
          })
          .from(companyMemberships)
          .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.status, "active"),
            ),
          ),
      ]);

      const labelsByIssue = new Map<string, string[]>();
      for (const row of labelRows) {
        const list = labelsByIssue.get(row.issueId) ?? [];
        list.push(row.name);
        labelsByIssue.set(row.issueId, list);
      }

      const issueInputs: WorkforceIssueInput[] = issueRows.map((issue) => {
        const execution = readExecution(issue.executionState);
        const unblock = readUnblock(issue.unblockDescriptor);
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          status: issue.status,
          projectId: issue.projectId,
          parentId: issue.parentId,
          assigneeAgentId: issue.assigneeAgentId,
          assigneeUserId: issue.assigneeUserId,
          priority: issue.priority,
          checkoutRunId: issue.checkoutRunId,
          executionRunId: issue.executionRunId,
          currentStageType: execution.currentStageType,
          lastDecisionOutcome: execution.lastDecisionOutcome,
          executionParticipantUserId: execution.participantUserId,
          unblockAction: unblock.action,
          unblockOwnerUserId: unblock.ownerUserId,
          unblockOwnerBoard: unblock.ownerBoard,
          completedAt: iso(issue.completedAt),
          updatedAt: iso(issue.updatedAt) ?? now.toISOString(),
          monitorNextCheckAt: iso(issue.monitorNextCheckAt),
          labelNames: labelsByIssue.get(issue.id) ?? [],
        };
      });

      const loadedIssueIds = new Set(issueInputs.map((issue) => issue.id));
      let activityInputs = activityRows.map(toActivity);
      let truncated = issueRows.length >= WORKFORCE_OVERVIEW_LIMITS.issues;

      const initiative = resolveLoadedInitiative(initiativeQuery, issueInputs);
      if (initiative) {
        const subtree = collectSubtree(initiative.id, issueInputs);
        if (subtree.length > 0) {
          const extra = await db
            .select({
              id: activityLog.id,
              actorType: activityLog.actorType,
              actorId: activityLog.actorId,
              action: activityLog.action,
              entityType: activityLog.entityType,
              entityId: activityLog.entityId,
              agentId: activityLog.agentId,
              runId: activityLog.runId,
              details: activityLog.details,
              createdAt: activityLog.createdAt,
            })
            .from(activityLog)
            .where(and(eq(activityLog.companyId, companyId), inArray(activityLog.entityId, subtree)))
            .orderBy(desc(activityLog.createdAt))
            .limit(WORKFORCE_OVERVIEW_LIMITS.timeline);
          const seen = new Set(activityInputs.map((entry) => entry.id));
          for (const row of extra) {
            if (seen.has(row.id)) continue;
            activityInputs.push(toActivity(row));
          }
        }
      }

      const environmentIds = new Set(agentRows.map((agent) => agent.defaultEnvironmentId).filter((id): id is string => Boolean(id)));
      const snapshotEnvironments = environmentRows.filter((environment) => environmentIds.has(environment.id));

      const snapshot: WorkforceOverviewSnapshot = {
        companyId,
        now: now.toISOString(),
        truncated,
        initiativeQuery,
        agents: agentRows.map((agent): WorkforceAgentInput => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          title: agent.title,
          status: agent.status,
          reportsTo: agent.reportsTo,
          adapterType: agent.adapterType,
          model: readModel(agent.adapterConfig),
          environmentId: agent.defaultEnvironmentId,
          host: readHost(agent.adapterConfig),
          pauseReason: agent.pauseReason,
          pausedAt: iso(agent.pausedAt),
          errorReason: agent.errorReason,
          lastHeartbeatAt: iso(agent.lastHeartbeatAt),
        })),
        projects: projectRows.map((project): WorkforceProjectInput => ({
          id: project.id,
          name: project.name,
          status: project.status,
          leadAgentId: project.leadAgentId,
          pauseReason: project.pauseReason,
          pausedAt: iso(project.pausedAt),
          archivedAt: iso(project.archivedAt),
          updatedAt: iso(project.updatedAt) ?? now.toISOString(),
        })),
        issues: issueInputs,
        blockerEdges: relationRows.filter((edge) => loadedIssueIds.has(edge.blockedIssueId)),
        approvals: approvalRows.map((approval): WorkforceApprovalInput => {
          const title = readApprovalTitle(approval.payload);
          return {
            id: approval.id,
            type: approval.type,
            status: approval.status,
            title,
            security: Boolean(title && /\bsecurity\b/i.test(title)),
            createdAt: iso(approval.createdAt) ?? now.toISOString(),
          };
        }),
        runs: runRows.map((run): WorkforceRunInput => ({
          id: run.id,
          agentId: run.agentId,
          issueId: readRunIssueId(run.nativeIssueId, run.contextSnapshot),
          status: run.status,
          error: clip(run.error),
          errorCode: clip(run.errorCode),
          livenessReason: clip(run.livenessReason),
          nextAction: clip(run.nextAction),
          scheduledRetryReason: clip(run.scheduledRetryReason),
          startedAt: iso(run.startedAt),
          finishedAt: iso(run.finishedAt),
          updatedAt: iso(run.updatedAt) ?? now.toISOString(),
          createdAt: iso(run.createdAt) ?? now.toISOString(),
        })),
        activity: activityInputs,
        workProducts: workProductRows.map((product): WorkforceWorkProductInput => ({
          id: product.id,
          issueId: product.issueId,
          projectId: product.projectId,
          type: product.type,
          title: product.title,
          url: product.url,
          openPath: readOpenPath(product.metadata),
          status: product.status,
          reviewState: product.reviewState,
          updatedAt: iso(product.updatedAt) ?? now.toISOString(),
        })),
        members: memberRows,
        environments: snapshotEnvironments,
      };

      if (activityRows.length >= WORKFORCE_OVERVIEW_LIMITS.activity || workProductRows.length >= WORKFORCE_OVERVIEW_LIMITS.workProducts || runRows.length >= WORKFORCE_OVERVIEW_LIMITS.runs) {
        truncated = true;
        snapshot.truncated = true;
      }

      return projectWorkforceOverview(snapshot);
    },
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /token|secret|password|api[_-]?key/i.test(trimmed)) return null;
  return trimmed.length > 180 ? `${trimmed.slice(0, 179)}…` : trimmed;
}

function readModel(config: Record<string, unknown> | null | undefined): string | null {
  if (!config) return null;
  for (const key of ["model", "modelName", "defaultModel"]) {
    const value = config[key];
    if (typeof value === "string") {
      const safe = clip(value);
      if (safe && safe.length <= 120) return safe;
    }
  }
  return null;
}

function readHost(config: Record<string, unknown> | null | undefined): string | null {
  if (!config) return null;
  const value = config.host ?? config.hostname;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[a-z0-9.-]+$/i.test(trimmed)) return null;
  return trimmed;
}

function readExecution(value: unknown): {
  currentStageType: string | null;
  lastDecisionOutcome: string | null;
  participantUserId: string | null;
} {
  if (!value || typeof value !== "object") {
    return { currentStageType: null, lastDecisionOutcome: null, participantUserId: null };
  }
  const record = value as Record<string, unknown>;
  const participant = record.currentParticipant;
  const participantUserId =
    participant && typeof participant === "object" && (participant as { type?: unknown }).type === "user"
      ? clipString((participant as { userId?: unknown }).userId)
      : null;
  return {
    currentStageType: clipString(record.currentStageType),
    lastDecisionOutcome: clipString(record.lastDecisionOutcome),
    participantUserId,
  };
}

function readUnblock(value: unknown): { action: string | null; ownerUserId: string | null; ownerBoard: boolean } {
  if (!value || typeof value !== "object") return { action: null, ownerUserId: null, ownerBoard: false };
  const record = value as Record<string, unknown>;
  const owner = record.owner;
  const ownerUserId =
    owner && typeof owner === "object" && "userId" in owner ? clipString((owner as { userId?: unknown }).userId) : null;
  return {
    action: clip(typeof record.action === "string" ? record.action : null),
    ownerUserId,
    ownerBoard: owner === "board",
  };
}

function clipString(value: unknown): string | null {
  return typeof value === "string" ? clip(value) : null;
}

function readApprovalTitle(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  for (const key of ["title", "summary", "name"]) {
    const value = payload[key];
    if (typeof value === "string") {
      const safe = clip(value);
      if (safe) return safe;
    }
  }
  return null;
}

function readRunIssueId(nativeIssueId: string | null, snapshot: unknown): string | null {
  if (nativeIssueId) return nativeIssueId;
  if (snapshot && typeof snapshot === "object" && "issueId" in snapshot) {
    const issueId = (snapshot as { issueId?: unknown }).issueId;
    if (typeof issueId === "string" && issueId.trim()) return issueId;
  }
  return null;
}

function readOpenPath(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const openPath = metadata.openPath;
  if (typeof openPath !== "string") return null;
  const trimmed = openPath.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  return trimmed;
}

function readDetailText(details: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!details) return null;
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string") {
      const safe = clip(value);
      if (safe) return safe;
    }
  }
  return null;
}

function toActivity(row: {
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): WorkforceActivityInput {
  return {
    id: row.id,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    agentId: row.agentId,
    runId: row.runId,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    summary: readDetailText(row.details, ["summary", "title", "comment", "message"]),
    mentionedAssignee: readDetailText(row.details, ["assigneeName", "assigneeAgentName", "to"]),
  };
}

function resolveLoadedInitiative(query: string | null, issues: WorkforceIssueInput[]): WorkforceIssueInput | null {
  if (!query) return defaultWorkforceInitiative(issues);
  return issues.find((issue) => issue.id === query || issue.identifier === query) ?? null;
}

function collectSubtree(rootId: string, issues: WorkforceIssueInput[]): string[] {
  const children = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const list = children.get(issue.parentId) ?? [];
    list.push(issue.id);
    children.set(issue.parentId, list);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    for (const child of children.get(id) ?? []) stack.push(child);
  }
  return ids;
}
