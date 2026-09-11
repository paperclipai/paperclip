import { createHash } from "node:crypto";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "../issue-execution-policy.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

export const DISPOSITION_REPAIR_MAX_ATTEMPTS = 5;
export const DISPOSITION_REPAIR_BASE_DELAYS_MS = [0, 60_000, 120_000, 240_000, 480_000] as const;

type DispositionRepairIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionPolicy"
  | "executionState"
  | "monitorNextCheckAt"
>;

export type DispositionRepairSourceState = {
  fingerprint: string;
  dependencyIssueIds: string[];
  hasActiveExecutionPath: boolean;
  hasDurableWaitingPath: boolean;
  durablePathReason: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedRecoveryDelayMs(
  attempt: number,
  fingerprint: string,
  delays: readonly number[],
  lane: string,
) {
  const baseDelayMs = delays[attempt - 1];
  if (baseDelayMs === undefined) throw new Error(`Invalid ${lane} attempt: ${attempt}`);
  if (baseDelayMs === 0) return { baseDelayMs, jitterMs: 0, delayMs: 0 };

  const jitterBoundMs = Math.floor(baseDelayMs * 0.1);
  const sample = Number.parseInt(
    createHash("sha256").update(`${fingerprint}:${attempt}`).digest("hex").slice(0, 8),
    16,
  );
  const jitterMs = sample % (jitterBoundMs + 1);
  return { baseDelayMs, jitterMs, delayMs: baseDelayMs + jitterMs };
}

export function dispositionRepairDelayMs(attempt: number, fingerprint: string) {
  return boundedRecoveryDelayMs(
    attempt,
    fingerprint,
    DISPOSITION_REPAIR_BASE_DELAYS_MS,
    "disposition repair",
  );
}

export async function collectDispositionRepairSourceState(
  db: Db,
  input: {
    issue: DispositionRepairIssue;
    excludeRunId?: string | null;
    excludeWakeupRequestId?: string | null;
  },
): Promise<DispositionRepairSourceState> {
  const issue = input.issue;
  const [blockers, children, interactions, linkedApprovals, workProducts, activeRuns, queuedWakes] =
    await Promise.all([
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issueRelations)
        .innerJoin(
          issues,
          and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)),
        )
        .where(
          and(
            eq(issueRelations.companyId, issue.companyId),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issueRelations.type, "blocks"),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, issue.companyId),
            eq(issues.parentId, issue.id),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
          kind: issueThreadInteractions.kind,
          continuationPolicy: issueThreadInteractions.continuationPolicy,
          updatedAt: issueThreadInteractions.updatedAt,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            inArray(issueThreadInteractions.status, ["pending", "accepted", "answered"]),
          ),
        ),
      db
        .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
        .from(issueApprovals)
        .innerJoin(
          approvals,
          and(
            eq(issueApprovals.approvalId, approvals.id),
            eq(issueApprovals.companyId, approvals.companyId),
          ),
        )
        .where(
          and(
            eq(issueApprovals.companyId, issue.companyId),
            eq(approvals.companyId, issue.companyId),
            eq(issueApprovals.issueId, issue.id),
            inArray(approvals.status, ["pending", "revision_requested", "approved"]),
          ),
        ),
      db
        .select({
          id: issueWorkProducts.id,
          type: issueWorkProducts.type,
          status: issueWorkProducts.status,
          reviewState: issueWorkProducts.reviewState,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, issue.companyId),
            eq(issueWorkProducts.issueId, issue.id),
          ),
        ),
      db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, issue.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : sql`true`,
          ),
        ),
      db
        .select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            input.excludeWakeupRequestId
              ? ne(agentWakeupRequests.id, input.excludeWakeupRequestId)
              : sql`true`,
          ),
        ),
    ]);

  const pendingExecutionState = parseIssueExecutionState(issue.executionState);
  const pendingInteraction = interactions.some((row) => row.status === "pending");
  const pendingApproval = linkedApprovals.some((row) =>
    row.status === "pending" || row.status === "revision_requested",
  );
  const durablePathReason = issue.assigneeUserId
    ? "user_owner"
    : blockers.length > 0
      ? "blocker"
      : issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now()
        ? "monitor"
        : pendingExecutionState?.status === "pending"
          ? "execution_stage"
          : pendingInteraction
            ? "interaction"
            : pendingApproval
              ? "approval"
              : null;

  const durableState = {
    source: {
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      executionPolicy: issue.executionPolicy,
      executionState: issue.executionState,
      monitorNextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? null,
    },
    blockers: blockers.sort((a, b) => a.id.localeCompare(b.id)),
    children: children.sort((a, b) => a.id.localeCompare(b.id)),
    interactions: interactions
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    approvals: linkedApprovals
      .map((row) => ({ ...row, decidedAt: row.decidedAt?.toISOString() ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    workProducts: workProducts
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const digest = createHash("sha256").update(stableJson(durableState)).digest("hex");

  return {
    fingerprint: `disposition_repair:v1:${digest}`,
    dependencyIssueIds: [...new Set([...blockers.map((row) => row.id), ...children.map((row) => row.id)])],
    hasActiveExecutionPath: activeRuns.length > 0 || queuedWakes.length > 0,
    hasDurableWaitingPath: durablePathReason !== null,
    durablePathReason,
  };
}
