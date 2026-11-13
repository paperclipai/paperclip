import { and, eq, sql } from "drizzle-orm";
import { activityLog, executionWorkspaces, issues, projectWorkspaces, type Db } from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertTaskWorkspaceExecutionAccess } from "./task-workspace-access.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { taskWorkspaceSelectableCondition } from "./task-workspace-selection.js";

export const REQUESTED_PROJECT_REPOSITORIES_METADATA_KEY = "requestedProjectRepositoryIds";

export function readRequestedProjectRepositoryIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const ids = (metadata as Record<string, unknown>)[REQUESTED_PROJECT_REPOSITORIES_METADATA_KEY];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

export async function requestProjectRepository(db: Db, input: {
  companyId: string;
  issueId: string;
  actor: AuthorizationActor;
  projectWorkspaceId: string;
}) {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      await issueReadSqlCondition(tx as unknown as Db, input.actor))).for("no key update");
    if (!issue) throw notFound("Task not found");
    const decision = await authorizationService(tx as unknown as Db).decide({ actor: input.actor, action: "issue:mutate", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    } });
    if (!decision.allowed) throw forbidden("Task workspace modification is not allowed");
    if (input.actor.type === "agent" && !["standard", "skill_test"].includes(issue.workMode)) {
      throw forbidden("Repository preparation is unavailable in Ask or Plan mode");
    }
    if (!issue.executionWorkspaceId) throw conflict("The task has no admitted workspace yet. Start it once before requesting a repository.");
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId),
      eq(executionWorkspaces.companyId, input.companyId), taskWorkspaceSelectableCondition())).for("update");
    if (!workspace) throw conflict("Execution workspace is unavailable");
    await assertTaskWorkspaceExecutionAccess(tx as unknown as Db, input.actor, input.companyId, { issueId: issue.id, workspaceId: workspace.id });
    if (!workspace.projectId) throw conflict("The task workspace does not belong to a project");
    const [source] = await tx.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl }).from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, input.projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId),
      eq(projectWorkspaces.projectId, workspace.projectId)));
    if (!source) throw notFound("Project repository not found");
    if (!source.repoUrl) throw conflict("This project workspace has no repository to check out");
    const requested = readRequestedProjectRepositoryIds(workspace.metadata);
    if (!requested.includes(source.id)) {
      await tx.update(executionWorkspaces).set({
        metadata: sql`coalesce(${executionWorkspaces.metadata}, '{}'::jsonb) || jsonb_build_object(${REQUESTED_PROJECT_REPOSITORIES_METADATA_KEY}::text, ${JSON.stringify([...requested, source.id])}::jsonb)`,
        updatedAt: new Date(),
      }).where(eq(executionWorkspaces.id, workspace.id));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: input.actor.type === "agent" ? "agent" : "user",
        actorId: input.actor.agentId ?? input.actor.userId ?? "local-board",
        action: "workspace.project_repository.requested",
        entityType: "execution_workspace",
        entityId: workspace.id,
        runId: input.actor.runId ?? null,
        details: { issueId: issue.id, projectWorkspaceId: source.id, applies: "next_normal_admission" },
      });
    }
    return { kind: "requires_next_admission" as const, applies: "next_normal_admission" as const, projectWorkspaceId: source.id };
  });
}
