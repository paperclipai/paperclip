import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, issues, workFolderRuns, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { issueExecutionWorkspaceModeForPersistedWorkspace } from "./execution-workspace-policy.js";

/** Sandbox reuse is independent of whether the provider process stays warm. */
export function shouldBindReusableSandboxWorkspace(environment: {
  driver: string;
  config: unknown;
} | null | undefined): boolean {
  const config = environment?.config;
  return environment?.driver === "sandbox"
    && typeof config === "object"
    && config !== null
    && !Array.isArray(config)
    && (config as Record<string, unknown>).reuseLease === true;
}

/** Early scoped-folder releases saved task state without always binding the issue. */
export async function findUnboundScopedTaskWorkspace(db: Db, input: {
  companyId: string; issueId: string | null; projectId: string | null;
  agentId: string; responsibleUserId: string | null; adapterType: string;
  executionWorkspaceId: string | null; executionWorkspacePreference: string | null;
  environment: Pick<Environment, "id" | "driver" | "config"> | null;
}) {
  const environment = input.environment;
  if (!input.issueId || !input.projectId || input.executionWorkspaceId || input.executionWorkspacePreference
    || !environment || !shouldBindReusableSandboxWorkspace(environment)) return null;
  const [candidate] = await db.select({ workspaceId: executionWorkspaces.id }).from(environmentLeases)
    .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.id, environmentLeases.executionWorkspaceId),
      eq(executionWorkspaces.companyId, environmentLeases.companyId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
      eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .innerJoin(workFolderRuns, and(eq(workFolderRuns.runId, heartbeatRuns.id),
      eq(workFolderRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.issueId, input.issueId),
      eq(environmentLeases.environmentId, environment.id),
      eq(environmentLeases.leasePolicy, "reuse_by_environment"),
      inArray(environmentLeases.status, ["released", "retained"]), isNotNull(environmentLeases.providerLeaseId),
      sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
      sql`${environmentLeases.metadata}->>'workFolderLayout' = 'scoped'`,
      sql`${environmentLeases.metadata}->'reusableSandboxLease' @> ${JSON.stringify({
        version: 2, companyId: input.companyId, issueId: input.issueId, agentId: input.agentId,
        responsibleUserId: input.responsibleUserId, environmentId: environment.id, adapterType: input.adapterType,
      })}::jsonb`,
      sql`${environmentLeases.metadata}->'reusableSandboxLease'->>'executionWorkspaceId' = ${executionWorkspaces.id}::text`,
      sql`${environmentLeases.metadata}->'reusableSandboxLease'->>'provider' = ${environmentLeases.provider}`,
      eq(heartbeatRuns.agentId, input.agentId),
      input.responsibleUserId === null ? isNull(heartbeatRuns.responsibleUserId)
        : eq(heartbeatRuns.responsibleUserId, input.responsibleUserId),
      eq(executionWorkspaces.projectId, input.projectId), eq(executionWorkspaces.sourceIssueId, input.issueId),
      eq(executionWorkspaces.status, "active"),
      sql`${workFolderRuns.manifest} @> ${JSON.stringify({
        version: 1, companyId: input.companyId, taskId: input.issueId, projectId: input.projectId,
        agentId: input.agentId, responsibleUserId: input.responsibleUserId,
      })}::jsonb`,
      sql`${workFolderRuns.manifest}->>'leaseId' = ${environmentLeases.id}::text`,
      sql`${workFolderRuns.manifest}->>'runId' = ${heartbeatRuns.id}::text`))
    .orderBy(desc(environmentLeases.createdAt), desc(environmentLeases.id)).limit(1);
  // Workspace freshness, lease fingerprints and provider sentinels still gate reuse.
  return candidate?.workspaceId ?? null;
}

/** Host runtime state must survive even when user-configurable worktrees are disabled. */
export async function bindReusableSandboxWorkspace(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string; workspaceId: string;
}) {
  const publications: ActivityPublication[] = [];
  await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      eq(issues.executionRunId, input.runId),
    )).for("update");
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
    )).for("update");
    if (!issue || !run || !workspace || workspace.projectId !== issue.projectId || workspace.status !== "active"
      || (workspace.sourceIssueId !== null && workspace.sourceIssueId !== issue.id)) {
      throw new Error("Reusable sandbox workspace no longer belongs to this active task run");
    }
    await tx.update(issues).set({
      executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        ...(issue.executionWorkspaceSettings ?? {}),
        mode: issueExecutionWorkspaceModeForPersistedWorkspace(workspace.mode),
      },
      ...(workspace.projectWorkspaceId ? { projectWorkspaceId: workspace.projectWorkspaceId } : {}),
      updatedAt: new Date(),
    }).where(eq(issues.id, issue.id));
    await logActivity(tx as unknown as Db, {
      companyId: input.companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
      runId: input.runId, issueId: issue.id, action: "execution_workspace.sandbox_bound",
      entityType: "execution_workspace", entityId: workspace.id,
      details: { issueId: issue.id, reason: "sandbox_reuse" },
    }, publications);
  });
  for (const publication of publications) publishActivity(publication);
}
