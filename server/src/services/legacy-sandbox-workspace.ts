import { and, desc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, workFolderRuns, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function hasLegacySandboxWorkspace(lease: Pick<EnvironmentLease, "metadata">) {
  return lease.metadata?.workFolderLayout === "legacy"
    || record(lease.metadata?.reusableSandboxLease)?.version === 1;
}

/** Older releases retained sandboxes without binding their workspace to the task. */
export async function findUnboundLegacyTaskWorkspace(db: Db, input: {
  companyId: string; issueId: string | null; projectId: string | null;
  agentId: string; responsibleUserId: string | null; adapterType: string;
  executionWorkspaceId: string | null; executionWorkspacePreference: string | null;
  environment: Pick<Environment, "id" | "driver" | "config"> | null;
}) {
  if (!input.issueId || !input.projectId || input.executionWorkspaceId || input.executionWorkspacePreference
    || input.environment?.driver !== "sandbox" || input.environment.config.reuseLease !== true) return null;
  let before: { createdAt: string; id: string } | undefined;
  while (true) {
    const candidates = await db.select({ lease: environmentLeases,
      createdAt: sql<string>`${environmentLeases.createdAt}::text` }).from(environmentLeases)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
        eq(heartbeatRuns.companyId, environmentLeases.companyId)))
      .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.id, environmentLeases.executionWorkspaceId),
        eq(executionWorkspaces.companyId, environmentLeases.companyId)))
      .where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.issueId, input.issueId),
        before ? sql`(${environmentLeases.createdAt}, ${environmentLeases.id}) < (${before.createdAt}::timestamptz, ${before.id}::uuid)` : undefined,
        eq(environmentLeases.environmentId, input.environment.id),
        eq(environmentLeases.leasePolicy, "reuse_by_environment"),
        inArray(environmentLeases.status, ["retained", "released"]),
        isNotNull(environmentLeases.providerLeaseId),
        sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
        sql`${environmentLeases.metadata}->>'workFolderLayout' is distinct from 'scoped'`,
        sql`${environmentLeases.metadata}->'reusableSandboxLease'->>'version' = '1'`,
        eq(heartbeatRuns.agentId, input.agentId),
        input.responsibleUserId === null ? isNull(heartbeatRuns.responsibleUserId)
          : eq(heartbeatRuns.responsibleUserId, input.responsibleUserId),
        eq(executionWorkspaces.projectId, input.projectId), eq(executionWorkspaces.status, "active"),
        or(isNull(executionWorkspaces.sourceIssueId), eq(executionWorkspaces.sourceIssueId, input.issueId)),
        notExists(db.select({ id: workFolderRuns.runId }).from(workFolderRuns).where(and(
          eq(workFolderRuns.companyId, input.companyId), sql`${workFolderRuns.manifest}->>'taskId' = ${input.issueId}`)))))
      .orderBy(desc(environmentLeases.createdAt), desc(environmentLeases.id)).limit(100);
    if (!candidates.length) return null;
    for (const candidate of candidates) {
      const lease = await bindLegacySandboxIdentity(db, candidate.lease as EnvironmentLease);
      const scope = record(lease.metadata?.reusableSandboxLease);
      if (scope?.version !== 2 || scope.issueId !== input.issueId || scope.responsibleUserId !== input.responsibleUserId
        || scope.adapterType !== input.adapterType || scope.environmentId !== input.environment.id
        || scope.executionWorkspaceId !== lease.executionWorkspaceId) continue;
      // Normal workspace freshness and provider sentinel checks still run before use.
      return lease.executionWorkspaceId;
    }
    // Invalid newer lease records must not hide an older recoverable workspace.
    // Keep Postgres microseconds intact across page boundaries.
    const last = candidates[candidates.length - 1]!;
    before = { createdAt: last.createdAt, id: last.lease.id };
  }
}

/** Keep the old sync/restore contract even after its provider sandbox expires. */
export async function taskUsesLegacySandboxWorkspace(db: Db, companyId: string, issueId: string | null) {
  if (!issueId) return false;
  const [previous] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .leftJoin(workFolderRuns, eq(workFolderRuns.runId, heartbeatRuns.id))
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.issueId, issueId),
      sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
      // A failed or interrupted old run may still have written valuable work.
      // New leases are marked scoped before preparation, so preparation failure
      // must not accidentally opt a new task into the compatibility path.
      sql`${environmentLeases.metadata}->>'workFolderLayout' is distinct from 'scoped'`,
      or(eq(heartbeatRuns.status, "succeeded"), isNotNull(heartbeatRuns.startedAt),
        sql`${environmentLeases.metadata}->'reusableSandboxLease'->>'version' = '1'`,
        sql`${environmentLeases.metadata}->>'workFolderLayout' = 'legacy'`),
      isNull(workFolderRuns.runId),
      notExists(db.select({ id: workFolderRuns.runId }).from(workFolderRuns).where(and(
        eq(workFolderRuns.companyId, companyId), sql`${workFolderRuns.manifest}->>'taskId' = ${issueId}`))))).limit(1);
  return Boolean(previous);
}

/** Recover the missing identity from host records, never from provider claims. */
export async function bindLegacySandboxIdentity(db: Db, lease: EnvironmentLease): Promise<EnvironmentLease> {
  const scope = record(lease.metadata?.reusableSandboxLease);
  if (scope?.version !== 1 || !lease.heartbeatRunId) return lease;
  const [run] = await db.select({ agentId: heartbeatRuns.agentId,
    responsibleUserId: heartbeatRuns.responsibleUserId, context: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId)));
  if (!run || run.agentId !== scope.agentId || scope.companyId !== lease.companyId) return lease;
  const context = run.context ?? {};
  const taskIds = [lease.issueId, context.issueId, context.taskId, context.taskKey]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(taskIds).size > 1) return lease;
  const issueId = taskIds[0] ?? null;
  return { ...lease, metadata: { ...lease.metadata, workFolderLayout: "legacy",
    reusableSandboxLease: { ...scope, version: 2, responsibleUserId: run.responsibleUserId, issueId } } };
}
