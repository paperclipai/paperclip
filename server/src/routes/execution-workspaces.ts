import { and, asc, desc, eq, or } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentTaskSessions, assets, executionWorkspaces, issueAttachments, issues, projectWorkspaces, projects } from "@paperclipai/db";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { updateExecutionWorkspaceSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { executionWorkspaceService, logActivity, workspaceOperationService } from "../services/index.js";
import { mergeExecutionWorkspaceConfig, readExecutionWorkspaceConfig } from "../services/execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "../services/execution-workspace-policy.js";
import { readProjectWorkspaceRuntimeConfig } from "../services/project-workspace-runtime-config.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

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

  router.get("/execution-workspaces/:id/close-readiness", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    const readiness = await svc.getCloseReadiness(id);
    if (!readiness) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    res.json(readiness);
  });

  router.get("/execution-workspaces/:id/workspace-operations", async (req, res) => {
    const id = req.params.id as string;
    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, workspace.companyId);
    const operations = await workspaceOperationsSvc.listForExecutionWorkspace(id);
    res.json(operations);
  });

  router.post("/execution-workspaces/:id/runtime-services/:action", async (req, res) => {
    const id = req.params.id as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart") {
      res.status(404).json({ error: "Runtime service action not found" });
      return;
    }

    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const workspaceCwd = existing.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Execution workspace needs a local path before Paperclip can manage local runtime services" });
      return;
    }

    const projectWorkspace = existing.projectWorkspaceId
      ? await db
          .select({
            id: projectWorkspaces.id,
            cwd: projectWorkspaces.cwd,
            repoUrl: projectWorkspaces.repoUrl,
            repoRef: projectWorkspaces.repoRef,
            defaultRef: projectWorkspaces.defaultRef,
            metadata: projectWorkspaces.metadata,
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
    const projectWorkspaceRuntime = readProjectWorkspaceRuntimeConfig(
      (projectWorkspace?.metadata as Record<string, unknown> | null) ?? null,
    )?.workspaceRuntime ?? null;
    const effectiveRuntimeConfig = existing.config?.workspaceRuntime ?? projectWorkspaceRuntime ?? null;

    if ((action === "start" || action === "restart") && !effectiveRuntimeConfig) {
      res.status(422).json({ error: "Execution workspace has no runtime service configuration or inherited project workspace default" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperationsSvc.createRecorder({
      companyId: existing.companyId,
      executionWorkspaceId: existing.id,
    });
    let runtimeServiceCount = existing.runtimeServices?.length ?? 0;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: `workspace runtime ${action}`,
      cwd: existing.cwd,
      metadata: {
        action,
        executionWorkspaceId: existing.id,
      },
      run: async () => {
        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout.push(chunk);
          else stderr.push(chunk);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForExecutionWorkspace({
            db,
            executionWorkspaceId: existing.id,
            workspaceCwd,
          });
        }

        if (action === "start" || action === "restart") {
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: existing.companyId,
            },
            issue: existing.sourceIssueId
              ? {
                  id: existing.sourceIssueId,
                  identifier: null,
                  title: existing.name,
                }
              : null,
            workspace: {
              baseCwd: workspaceCwd,
              source: existing.mode === "shared_workspace" ? "project_primary" : "task_session",
              projectId: existing.projectId,
              workspaceId: existing.projectWorkspaceId,
              repoUrl: existing.repoUrl,
              repoRef: existing.baseRef,
              strategy: existing.strategyType === "git_worktree" ? "git_worktree" : "project_primary",
              cwd: workspaceCwd,
              branchName: existing.branchName,
              worktreePath: existing.strategyType === "git_worktree" ? workspaceCwd : null,
              warnings: [],
              created: false,
            },
            executionWorkspaceId: existing.id,
            config: { workspaceRuntime: effectiveRuntimeConfig },
            adapterEnv: {},
            onLog,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = 0;
        }

        const metadata = mergeExecutionWorkspaceConfig(existing.metadata as Record<string, unknown> | null, {
          desiredState: action === "stop" ? "stopped" : "running",
        });
        await svc.update(existing.id, { metadata });

        return {
          status: "succeeded",
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          system:
            action === "stop"
              ? "Stopped execution workspace runtime services.\n"
              : action === "restart"
                ? "Restarted execution workspace runtime services.\n"
                : "Started execution workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
          },
        };
      },
    });

    const workspace = await svc.getById(id);
    if (!workspace) {
      res.status(404).json({ error: "Execution workspace not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: `execution_workspace.runtime_${action}`,
      entityType: "execution_workspace",
      entityId: existing.id,
      details: {
        runtimeServiceCount,
      },
    });

    res.json({
      workspace,
      operation,
    });
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
      ...(req.body.name === undefined ? {} : { name: req.body.name }),
      ...(req.body.cwd === undefined ? {} : { cwd: req.body.cwd }),
      ...(req.body.repoUrl === undefined ? {} : { repoUrl: req.body.repoUrl }),
      ...(req.body.baseRef === undefined ? {} : { baseRef: req.body.baseRef }),
      ...(req.body.branchName === undefined ? {} : { branchName: req.body.branchName }),
      ...(req.body.providerRef === undefined ? {} : { providerRef: req.body.providerRef }),
      ...(req.body.status === undefined ? {} : { status: req.body.status }),
      ...(req.body.cleanupReason === undefined ? {} : { cleanupReason: req.body.cleanupReason }),
      ...(req.body.cleanupEligibleAt !== undefined
        ? { cleanupEligibleAt: req.body.cleanupEligibleAt ? new Date(req.body.cleanupEligibleAt) : null }
        : {}),
    };
    if (req.body.metadata !== undefined || req.body.config !== undefined) {
      const requestedMetadata = req.body.metadata === undefined
        ? (existing.metadata as Record<string, unknown> | null)
        : (req.body.metadata as Record<string, unknown> | null);
      patch.metadata = req.body.config === undefined
        ? requestedMetadata
        : mergeExecutionWorkspaceConfig(requestedMetadata, req.body.config ?? null);
    }
    let workspace = existing;
    let cleanupWarnings: string[] = [];
    const configForCleanup = readExecutionWorkspaceConfig(
      ((patch.metadata as Record<string, unknown> | null | undefined) ?? (existing.metadata as Record<string, unknown> | null)) ?? null,
    );

    if (req.body.status === "archived" && existing.status !== "archived") {
      const readiness = await svc.getCloseReadiness(existing.id);
      if (!readiness) {
        res.status(404).json({ error: "Execution workspace not found" });
        return;
      }

      if (readiness.state === "blocked") {
        res.status(409).json({
          error: readiness.blockingReasons[0] ?? "Execution workspace cannot be closed right now",
          closeReadiness: readiness,
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

      if (existing.mode === "shared_workspace") {
        await db
          .update(issues)
          .set({
            executionWorkspaceId: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.companyId, existing.companyId),
              eq(issues.executionWorkspaceId, existing.id),
            ),
          );
      }

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
          teardownCommand: configForCleanup?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
          cleanupCommand: configForCleanup?.cleanupCommand ?? null,
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

  /**
   * Serve an HTML report file from the most-recent execution workspace for an issue.
   * Only files inside the `reports/` subdirectory are accessible.
   *
   * GET /companies/:companyId/issues/:issueId/reports/:filename
   */
  router.get("/companies/:companyId/issues/:issueId/reports/:filename", async (req, res) => {
    const { companyId, issueId, filename } = req.params as {
      companyId: string;
      issueId: string;
      filename: string;
    };
    assertCompanyAccess(req, companyId);

    if (!filename.endsWith(".html") && !filename.endsWith(".htm")) {
      res.status(400).json({ error: "Only HTML report files are served via this endpoint" });
      return;
    }

    // Prevent path traversal
    const safeName = path.basename(filename);
    if (safeName !== filename || safeName.startsWith(".")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    // Resolve issue metadata for workspace lookup
    const issueRow = await db
      .select({
        executionWorkspaceId: issues.executionWorkspaceId,
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!issueRow) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    // Build ordered list of candidate workspace root directories to check.
    const candidateDirs: string[] = [];

    const pushDir = (raw: string | null | undefined) => {
      const p = raw?.trim();
      if (p) candidateDirs.push(p);
    };

    // 1. Execution workspaces linked to the issue (most reliable when they exist)
    const wsRows = await db
      .select({ providerRef: executionWorkspaces.providerRef, cwd: executionWorkspaces.cwd })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          issueRow.executionWorkspaceId
            ? or(
                eq(executionWorkspaces.id, issueRow.executionWorkspaceId),
                eq(executionWorkspaces.sourceIssueId, issueId),
              )
            : eq(executionWorkspaces.sourceIssueId, issueId),
        ),
      )
      .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt))
      .limit(10);

    for (const row of wsRows) {
      pushDir(row.providerRef);
      pushDir(row.cwd);
    }

    // 2. Project workspaces linked to the issue's project
    if (issueRow.projectId) {
      const pwRows = await db
        .select({ cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl })
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, companyId),
            eq(projectWorkspaces.projectId, issueRow.projectId),
          ),
        )
        .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt))
        .limit(5);
      for (const row of pwRows) pushDir(row.cwd);

      // Also try the managed workspace directory (used when project_workspace.cwd is null)
      try {
        const repoName = pwRows[0]?.repoUrl
          ? pwRows[0].repoUrl.split("/").pop()?.replace(/\.git$/, "") ?? null
          : null;
        pushDir(resolveManagedProjectWorkspaceDir({
          companyId,
          projectId: issueRow.projectId,
          repoName,
        }));
      } catch {
        // invalid ids — skip
      }
    }

    // 3. Agent task session cwd — the most direct record of where the agent actually ran.
    //    taskKey is set to issueId when the run is triggered for an issue.
    if (issueRow.assigneeAgentId) {
      const sessionRows = await db
        .select({ sessionParamsJson: agentTaskSessions.sessionParamsJson })
        .from(agentTaskSessions)
        .where(
          and(
            eq(agentTaskSessions.companyId, companyId),
            eq(agentTaskSessions.agentId, issueRow.assigneeAgentId),
            eq(agentTaskSessions.taskKey, issueId),
          ),
        )
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(3);

      for (const row of sessionRows) {
        const params = row.sessionParamsJson as Record<string, unknown> | null;
        if (typeof params?.cwd === "string") pushDir(params.cwd);
      }
    }

    // 4. Agent's default workspace directory (fallback when no project workspace exists)
    if (issueRow.assigneeAgentId) {
      try {
        pushDir(resolveDefaultAgentWorkspaceDir(issueRow.assigneeAgentId));
      } catch {
        // invalid agentId format — skip
      }
    }

    // Try each candidate directory
    let filePath: string | null = null;
    const checkedPaths: string[] = [];
    const seen = new Set<string>();
    for (const dir of candidateDirs) {
      const resolvedDir = path.resolve(dir);
      const candidate = path.resolve(resolvedDir, "reports", safeName);
      // Path traversal guard
      if (!candidate.startsWith(resolvedDir + path.sep)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      checkedPaths.push(candidate);
      try {
        await fs.access(candidate);
        filePath = candidate;
        break;
      } catch {
        // not here, keep looking
      }
    }

    if (!filePath) {
      // Fallback: look for an issue attachment with a matching filename.
      // The agent may have uploaded the file via the attachments API instead of keeping
      // it in the workspace filesystem.
      const attachmentRow = await db
        .select({ attachmentId: issueAttachments.id })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(
          and(
            eq(issueAttachments.companyId, companyId),
            eq(issueAttachments.issueId, issueId),
            eq(assets.originalFilename, safeName),
          ),
        )
        .orderBy(desc(issueAttachments.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (attachmentRow) {
        res.redirect(302, `/api/attachments/${attachmentRow.attachmentId}/content`);
        return;
      }

      res.status(404).json({
        error: "Report file not found",
        debug: { checkedPaths },
      });
      return;
    }

    const html = await fs.readFile(filePath, "utf8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self' 'unsafe-inline' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';");
    res.send(html);
  });

  return router;
}
