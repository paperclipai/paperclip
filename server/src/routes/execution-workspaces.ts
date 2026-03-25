import { and, eq } from "drizzle-orm";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { issues, projects, projectWorkspaces } from "@paperclipai/db";
import { updateExecutionWorkspaceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export function executionWorkspaceRoutes(db: Db) {
  const router = Router();
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);

  router.get("/companies/:companyId/execution-workspaces", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workspaces = await svc.list(companyId, {
      projectId: req.query.projectId as string | undefined,
      projectWorkspaceId: req.query.projectWorkspaceId as string | undefined,
      issueId: req.query.issueId as string | undefined,
      status: req.query.status as string | undefined,
      reuseEligible: req.query.reuseEligible === "true",
    });
    res.json(workspaces);
  });

  router.get("/execution-workspaces/:id", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    res.json(workspace);
  });

  router.patch("/execution-workspaces/:id", validate(updateExecutionWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const patch: Record<string, unknown> = {
      ...req.body,
      ...(req.body.cleanupEligibleAt ? { cleanupEligibleAt: new Date(req.body.cleanupEligibleAt) } : {}),
    };
    let workspace = existing;
    let cleanupWarnings: string[] = [];

    if (req.body.status === "archived" && existing.status !== "archived") {
      const linkedIssues = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, existing.companyId), eq(issues.executionWorkspaceId, existing.id)));
      const activeLinkedIssues = linkedIssues.filter((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status));

      if (activeLinkedIssues.length > 0) {
        res.status(409).json({
          error: `Cannot archive execution workspace while ${activeLinkedIssues.length} linked issue(s) are still open`,
        });
        return;
      }

      const closedAt = new Date();
      const archivedWorkspace = await svc.update(id, {
        ...patch,
        status: "archived",
        closedAt,
        cleanupReason: null,
      });
      if (!archivedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = archivedWorkspace;

      try {
        await stopRuntimeServicesForExecutionWorkspace({
          db,
          executionWorkspaceId: existing.id,
          workspaceCwd: existing.cwd,
        });
        const projectWorkspace = existing.projectWorkspaceId
          ? await db
              .select({
                cwd: projectWorkspaces.cwd,
                cleanupCommand: projectWorkspaces.cleanupCommand,
              })
              .from(projectWorkspaces)
              .where(
                and(
                  eq(projectWorkspaces.id, existing.projectWorkspaceId),
                  eq(projectWorkspaces.companyId, existing.companyId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
        const projectPolicy = existing.projectId
          ? await db
              .select({
                executionWorkspacePolicy: projects.executionWorkspacePolicy,
              })
              .from(projects)
              .where(and(eq(projects.id, existing.projectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
          : null;
        const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
          workspace: existing,
          projectWorkspace,
          teardownCommand: projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          recorder: workspaceOperationsSvc.createRecorder({
            companyId: existing.companyId,
            executionWorkspaceId: existing.id,
          }),
        });
        cleanupWarnings = cleanupResult.warnings;
        const cleanupPatch: Record<string, unknown> = {
          closedAt,
          cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
        };
        if (!cleanupResult.cleaned) {
          cleanupPatch.status = "cleanup_failed";
        }
        if (cleanupResult.warnings.length > 0 || !cleanupResult.cleaned) {
          workspace = (await svc.update(id, cleanupPatch)) ?? workspace;
        }
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        workspace =
          (await svc.update(id, {
            status: "cleanup_failed",
            closedAt,
            cleanupReason: failureReason,
          })) ?? workspace;
        res.status(500).json({
          error: `Failed to archive execution workspace: ${failureReason}`,
        });
        return;
      }
    } else {
      const updatedWorkspace = await svc.update(id, patch);
      if (!updatedWorkspace) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }
      workspace = updatedWorkspace;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "execution_workspace.updated",
      entityType: "execution_workspace",
      entityId: workspace.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      },
    });
    res.json(workspace);
  });

  return router;
}
