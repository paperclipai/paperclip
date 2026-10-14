import type { Db } from "@paperclipai/db";
import { issues, heartbeatRuns } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { canActorReadExecutionWorkspace, type AuthorizationActor, type AuthorizationDecision } from "./authorization.js";

type RunIssueBinding = {
  companyId: string;
  scopeKind?: "company" | "issue" | null;
  issueId?: string | null;
};

export async function canActorReadHeartbeatRun(
  db: Db,
  access: {
    decide(input: {
      actor: AuthorizationActor;
      action: "issue:read";
      resource: {
        type: "issue";
        companyId: string;
        issueId: string;
        projectId: null;
        parentIssueId: null;
        assigneeAgentId: null;
        assigneeUserId: null;
      };
    }): Promise<AuthorizationDecision>;
  },
  actor: AuthorizationActor,
  run: RunIssueBinding,
): Promise<boolean> {
  if (run.scopeKind === "company") return true;
  if (!run.issueId) return false;

  const issueExists = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, run.issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows.length > 0);
  if (!issueExists) return false;

  const decision = await access.decide({
    actor,
    action: "issue:read",
    resource: {
      type: "issue",
      companyId: run.companyId,
      issueId: run.issueId,
      projectId: null,
      parentIssueId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    },
  });
  return decision.allowed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function pickTokenUsage(value: unknown) {
  const usage = asRecord(value);
  if (!usage) return null;
  const picked = {
    inputTokens: firstFinite(usage.inputTokens, usage.input_tokens),
    cachedInputTokens: firstFinite(usage.cachedInputTokens, usage.cached_input_tokens),
    outputTokens: firstFinite(usage.outputTokens, usage.output_tokens),
    totalTokens: firstFinite(usage.totalTokens, usage.total_tokens),
  };
  return Object.values(picked).some((item) => item !== null) ? picked : null;
}

function runDurationMs(row: Record<string, unknown>) {
  const startedAt = row.startedAt instanceof Date ? row.startedAt : new Date(String(row.startedAt ?? ""));
  const finishedAt = row.finishedAt instanceof Date ? row.finishedAt : new Date(String(row.finishedAt ?? ""));
  if (Number.isNaN(startedAt.getTime())) return null;
  const endMs = Number.isNaN(finishedAt.getTime()) ? Date.now() : finishedAt.getTime();
  return Math.max(0, endMs - startedAt.getTime());
}

/**
 * Locked list-row disclosure for an issue-bound run the actor cannot read.
 * Keep only identity, timing, status, and budget-oversight fields.
 */
export function redactHeartbeatRunListRow<T extends Record<string, unknown> & { id: string }>(row: T) {
  const usage = asRecord(row.usageJson);
  const result = asRecord(row.resultJson);
  const costUsd = firstFinite(
    row.costUsd,
    result?.costUsd,
    result?.cost_usd,
    result?.total_cost_usd,
    usage?.costUsd,
    usage?.cost_usd,
    usage?.total_cost_usd,
  );

  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    agentName: row.agentName,
    adapterType: row.adapterType,
    invocationSource: row.invocationSource,
    status: row.status,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    durationMs: runDurationMs(row),
    costUsd,
    usageJson: pickTokenUsage(row.usageJson ?? {
      inputTokens: row.inputTokens,
      cachedInputTokens: row.cachedInputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
    }),
    redacted: true,
  };
}

/** Check all durable sources, including tombstones left after a task/run is deleted. */
export async function canActorReadWorkspaceOperation(
  db: Db,
  access: Parameters<typeof canActorReadHeartbeatRun>[1],
  actor: AuthorizationActor,
  operation: { companyId: string; issueId?: string | null; heartbeatRunId?: string | null; executionWorkspaceId?: string | null; metadata?: Record<string, unknown> | null },
): Promise<boolean> {
  const sourceIds = (key: string, current?: string | null) => {
    const history = asRecord(operation.metadata?.[key]);
    return new Set([...Object.keys(history ?? {}), ...(current ? [current] : [])]);
  };
  const issueIds = sourceIds("_issuePrivacySources", operation.issueId);
  const runIds = sourceIds("_runPrivacySources", operation.heartbeatRunId);
  for (const issueId of issueIds) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(issueId)) return false;
    if (!(await canActorReadHeartbeatRun(db, access, actor, { companyId: operation.companyId, scopeKind: "issue", issueId }))) return false;
  }
  for (const runId of runIds) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)) return false;
    const [run] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, operation.companyId))).limit(1);
    if (!run || !(await canActorReadHeartbeatRun(db, access, actor, run))) return false;
  }
  if (operation.executionWorkspaceId) {
    if (!(await canActorReadExecutionWorkspace(db, actor, operation.executionWorkspaceId))) return false;
  }
  return issueIds.size > 0 || runIds.size > 0 || Boolean(operation.executionWorkspaceId);
}
