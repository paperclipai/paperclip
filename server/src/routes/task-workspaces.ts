import { and, eq } from "drizzle-orm";
import { executionWorkspaces, issues, projectWorkspaces, projects, type Db } from "@paperclipai/db";
import { Router, type Request } from "express";
import { prepareWorkspaceRepositorySchema, requestProjectRepositorySchema, selectTaskWorkspaceSchema } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueReadSqlCondition } from "../services/authorization.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { logActivity } from "../services/activity-log.js";
import { readProjectRepositoryCheckout, readRequestedProjectRepositoryIds, requestProjectRepository } from "../services/project-repository-requests.js";
import { forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo, hasCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";

export function taskWorkspaceRoutes(db: Db) {
  const router = Router();
  const workspaces = executionWorkspaceService(db);
  async function task(req: Request, write = false) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, req.params.id as string), await issueReadSqlCondition(db, req.actor)));
    if (!issue) throw notFound("Task not found");
    if (!hasCompanyAccess(req, issue.companyId)) throw notFound("Task not found");
    assertCompanyAccess(req, issue.companyId);
    const decision = await accessService(db).decide({ actor: req.actor, action: write ? "issue:mutate" : "issue:read", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    } });
    if (!decision.allowed) throw forbidden("Task workspace is outside this actor's authorization boundary");
    if (write && req.actor.type === "agent") {
      const context = await projectToolContext(db, req.actor, true, "Workspace");
      if (context.issue.id !== issue.id) throw forbidden("Workspace selection is scoped to the current task");
    }
    return issue;
  }
  async function listProjectRepositories(issue: typeof issues.$inferSelect) {
    if (!issue.executionWorkspaceId) return null;
    const [workspace] = await db.select({ projectId: executionWorkspaces.projectId, metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, issue.companyId)));
    const taskDirectory = !workspace?.projectId && issue.workspaceSelection?.selection.kind === "task_directory";
    const projectId = workspace?.projectId ?? (taskDirectory ? issue.projectId : null);
    if (!workspace || !projectId) return null;
    const [project] = await db.select({ repositoryCheckout: projects.repositoryCheckout }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, issue.companyId)));
    const requested = new Set(readRequestedProjectRepositoryIds(workspace.metadata));
    const sources = await db.select({ id: projectWorkspaces.id, name: projectWorkspaces.name, repoUrl: projectWorkspaces.repoUrl, isPrimary: projectWorkspaces.isPrimary })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, issue.companyId)));
    return {
      checkout: taskDirectory ? "none" : readProjectRepositoryCheckout(project?.repositoryCheckout),
      repositories: sources.filter(source => source.repoUrl).map(source => ({
        projectWorkspaceId: source.id, name: source.name, repoUrl: source.repoUrl, isPrimary: source.isPrimary, requested: requested.has(source.id),
      })),
    };
  }
  router.get("/issues/:id/workspace", async (req, res) => {
    const issue = await task(req);
    const view = await workspaces.inspectTaskWorkspace(issue.companyId, issue.id, req.actor);
    res.json({ ...view, repositories: issue.executionWorkspaceId ? await workspaces.listTaskRepositories(issue.companyId, issue.executionWorkspaceId) : [], projectRepositories: await listProjectRepositories(issue), capabilities: { prepareRepository: view.workspace?.providerType === "adapter_managed" ? "unsupported" : "next_normal_admission", selectWorkspace: "next_normal_admission" }, fileLocations: { taskFiles: "workspace", personalInstructionsAndMemory: "AGENT_HOME", providerHome: "runtime_managed" } });
  });
  router.put("/issues/:id/workspace", validate(selectTaskWorkspaceSchema), async (req, res) => {
    const issue = await task(req, true);
    const result = await workspaces.selectTaskWorkspace({ companyId: issue.companyId, issueId: issue.id, actor: req.actor, ...req.body });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, ...actor, action: "issue.workspace.selection_requested", entityType: "issue", entityId: issue.id, details: { selection: req.body.selection, applies: "next_normal_admission" } });
    res.json(result);
  });
  router.post("/issues/:id/workspace/repositories", validate(prepareWorkspaceRepositorySchema), async (req, res) => {
    const issue = await task(req, true);
    res.json(await workspaces.requestTaskRepository({ companyId: issue.companyId, issueId: issue.id, actor: req.actor, request: req.body }));
  });
  router.post("/issues/:id/workspace/project-repositories", validate(requestProjectRepositorySchema), async (req, res) => {
    const issue = await task(req, true);
    res.json(await requestProjectRepository(db, { companyId: issue.companyId, issueId: issue.id, actor: req.actor, projectWorkspaceId: req.body.projectWorkspaceId }));
  });
  return router;
}
