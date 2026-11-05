import type { Db } from "@paperclipai/db";
import { issues, heartbeatRuns } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { canActorReadExecutionWorkspace, type AuthorizationActor, type AuthorizationDecision, type authorizationService } from "./authorization.js";
import { retryIdempotentDatabaseOperation } from "../database-retry.js";

type RunIssueBinding = {
  companyId: string;
  scopeKind?: "company" | "issue" | null;
  issueId?: string | null;
};

export async function canActorReadHeartbeatRun(
  db: Db,
  access: {
    decideReads?: ReturnType<typeof authorizationService>["decideReads"];
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
  const issueId = run.issueId;
  if (!issueId) return false;

  // Callers pass the pooled Db, not a transaction. The existence check and
  // the issue:read decision only read, so each rebuilds after a transient
  // disconnect without replaying the other.
  const issueExists = await retryIdempotentDatabaseOperation(() => db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows.length > 0));
  if (!issueExists) return false;

  const decision = await retryIdempotentDatabaseOperation(() => access.decide({
    actor,
    action: "issue:read",
    resource: {
      type: "issue",
      companyId: run.companyId,
      issueId,
      projectId: null,
      parentIssueId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    },
  }));
  return decision.allowed;
}

export async function getHeartbeatRunReadDecisions(
  db: Db,
  access: Parameters<typeof canActorReadHeartbeatRun>[1],
  actor: AuthorizationActor,
  runs: readonly RunIssueBinding[],
): Promise<boolean[]> {
  const decideReads = access.decideReads;
  if (decideReads) {
    const bindings = runs.map(run => ({ companyId: run.companyId, scopeKind: run.scopeKind, issueId: run.issueId }));
    const key = (companyId: string, issueId: string) => JSON.stringify([companyId, issueId]);
    const issuesByCompany = new Map<string, Set<string>>();
    for (const run of bindings) {
      if (run.scopeKind === "company" || !run.issueId) continue;
      let ids = issuesByCompany.get(run.companyId);
      if (!ids) { ids = new Set(); issuesByCompany.set(run.companyId, ids); }
      ids.add(run.issueId);
    }
    const resources: Parameters<typeof decideReads>[1] = [];
    for (const [companyId, issueIds] of issuesByCompany) {
      const ids = [...issueIds];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const existing = await retryIdempotentDatabaseOperation(() => db
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, chunk))));
        for (const { id: issueId } of existing) resources.push({
          type: "issue", companyId, issueId, projectId: null, parentIssueId: null,
          assigneeAgentId: null, assigneeUserId: null,
        });
      }
    }
    const allowed = new Map<string, boolean>();
    if (resources.length) {
      const decisions = await retryIdempotentDatabaseOperation(() => decideReads(actor, resources));
      for (let index = 0; index < resources.length; index++) {
        const resource = resources[index];
        if (resource.type === "issue" && resource.issueId) {
          allowed.set(key(resource.companyId, resource.issueId), decisions[index]?.allowed === true);
        }
      }
    }
    return bindings.map(run => run.scopeKind === "company" || Boolean(run.issueId && allowed.get(key(run.companyId, run.issueId))));
  }
  const decisions = new Map<string, Promise<boolean>>();
  return Promise.all(runs.map(run => {
    const binding = { companyId: run.companyId, scopeKind: run.scopeKind, issueId: run.issueId };
    const key = JSON.stringify([binding.companyId, binding.scopeKind === "company", binding.issueId ?? null]);
    let decision = decisions.get(key);
    if (!decision) {
      decision = canActorReadHeartbeatRun(db, access, actor, binding);
      decisions.set(key, decision);
    }
    return decision;
  }));
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
    const [run] = await db.select({
      companyId: heartbeatRuns.companyId,
      scopeKind: heartbeatRuns.scopeKind,
      issueId: heartbeatRuns.issueId,
    }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, operation.companyId))).limit(1);
    if (!run || !(await canActorReadHeartbeatRun(db, access, actor, run))) return false;
  }
  if (operation.executionWorkspaceId) {
    if (!(await canActorReadExecutionWorkspace(db, actor, operation.executionWorkspaceId))) return false;
  }
  return issueIds.size > 0 || runIds.size > 0 || Boolean(operation.executionWorkspaceId);
}
