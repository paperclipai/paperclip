import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProjectSchema,
  projectFileBranchCreateSchema,
  projectFileBranchSwitchSchema,
  projectFileCreateSchema,
  projectFileDeleteSchema,
  projectFileReadSchema,
  projectFileRenameSchema,
  projectFileSaveSchema,
  projectFilesPathSchema,
  createProjectWorkspaceSchema,
  isUuidLike,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { projectFilesService, projectService, logActivity, secretService, workspaceOperationService, initWorkspaceGit } from "../services/index.js";
import { conflict, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { startRuntimeServicesForWorkspaceControl, stopRuntimeServicesForProjectWorkspace } from "../services/workspace-runtime.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { getTelemetryClient } from "../telemetry.js";

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const filesSvc = projectFilesService(db);
  const secretsSvc = secretService(db);
  const workspaceOperations = workspaceOperationService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function resolveCompanyIdForProjectReference(req: Request) {
    const companyIdQuery = req.query.companyId;
    const requestedCompanyId =
      typeof companyIdQuery === "string" && companyIdQuery.trim().length > 0
        ? companyIdQuery.trim()
        : null;
    if (requestedCompanyId) {
      assertCompanyAccess(req, requestedCompanyId);
      return requestedCompanyId;
    }
    if (req.actor.type === "agent" && req.actor.companyId) {
      return req.actor.companyId;
    }
    return null;
  }

  async function normalizeProjectReference(req: Request, rawId: string) {
    if (isUuidLike(rawId)) return rawId;
    const companyId = await resolveCompanyIdForProjectReference(req);
    if (!companyId) return rawId;
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    if (!resolved.project) {
      throw notFound("Project not found");
    }
    return resolved.project?.id ?? rawId;
  }

  router.param("id", async (req, _res, next, rawId) => {
    try {
      req.params.id = await normalizeProjectReference(req, rawId);
      next();
    } catch (err) {
      next(err);
    }
  });

  router.get("/companies/:companyId/projects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  router.get("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    res.json(project);
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;
    if (projectData.env !== undefined) {
      projectData.env = await secretsSvc.normalizeEnvBindingsForPersistence(
        companyId,
        projectData.env,
        { strictMode: strictSecretsMode, fieldPath: "env" },
      );
    }
    const project = await svc.create(companyId, projectData);
    let createdWorkspaceId: string | null = null;
    if (workspace) {
      const createdWorkspace = await svc.createWorkspace(project.id, workspace);
      if (!createdWorkspace) {
        await svc.remove(project.id);
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }
      createdWorkspaceId = createdWorkspace.id;
    } else {
      // Auto-create a default workspace pointing to the managed folder so every
      // project has a local git repo, even if no workspace was explicitly provided.
      const managedPath = resolveManagedProjectWorkspaceDir({ companyId, projectId: project.id });
      const autoWorkspace = await svc.createWorkspace(project.id, {
        name: project.name,
        cwd: managedPath,
        sourceType: "local_path",
      });
      if (autoWorkspace) createdWorkspaceId = autoWorkspace.id;
    }
    const hydratedProject = await svc.getById(project.id);

    // Fire-and-forget: initialize (or clone) the git workspace without blocking the response.
    const projectId = project.id;
    setImmediate(() => {
      svc.getById(projectId).then((fullProject) => {
        if (fullProject) return initWorkspaceGit(fullProject);
      }).catch((err) => {
        console.error("[git-init] workspace init failed for project", projectId, err);
      });
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.created",
      entityType: "project",
      entityId: project.id,
      details: {
        name: project.name,
        workspaceId: createdWorkspaceId,
        envKeys: project.env ? Object.keys(project.env).sort() : [],
      },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackProjectCreated(telemetryClient);
    }
    res.status(201).json(hydratedProject ?? project);
  });

  router.patch("/projects/:id", validate(updateProjectSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const body = { ...req.body };
    if (typeof body.archivedAt === "string") {
      body.archivedAt = new Date(body.archivedAt);
    }
    if (body.env !== undefined) {
      body.env = await secretsSvc.normalizeEnvBindingsForPersistence(existing.companyId, body.env, {
        strictMode: strictSecretsMode,
        fieldPath: "env",
      });
    }
    const project = await svc.update(id, body);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.updated",
      entityType: "project",
      entityId: project.id,
      details: {
        changedKeys: Object.keys(req.body).sort(),
        envKeys:
          body.env && typeof body.env === "object" && !Array.isArray(body.env)
            ? Object.keys(body.env as Record<string, unknown>).sort()
            : undefined,
      },
    });

    res.json(project);
  });

  router.get("/projects/:id/workspaces", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspaces = await svc.listWorkspaces(id);
    res.json(workspaces);
  });

  router.post("/projects/:id/workspaces", validate(createProjectWorkspaceSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspace = await svc.createWorkspace(id, req.body);
    if (!workspace) {
      res.status(422).json({ error: "Invalid project workspace payload" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_created",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
        cwd: workspace.cwd,
        isPrimary: workspace.isPrimary,
      },
    });

    res.status(201).json(workspace);
  });

  router.patch(
    "/projects/:id/workspaces/:workspaceId",
    validate(updateProjectWorkspaceSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const workspaceId = req.params.workspaceId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      const workspaceExists = (await svc.listWorkspaces(id)).some((workspace) => workspace.id === workspaceId);
      if (!workspaceExists) {
        res.status(404).json({ error: "Project workspace not found" });
        return;
      }
      const workspace = await svc.updateWorkspace(id, workspaceId, req.body);
      if (!workspace) {
        res.status(422).json({ error: "Invalid project workspace payload" });
        return;
      }

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "project.workspace_updated",
        entityType: "project",
        entityId: id,
        details: {
          workspaceId: workspace.id,
          changedKeys: Object.keys(req.body).sort(),
        },
      });

      res.json(workspace);
    },
  );

  router.post("/projects/:id/workspaces/:workspaceId/runtime-services/:action", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart") {
      res.status(404).json({ error: "Runtime service action not found" });
      return;
    }

    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const workspace = project.workspaces.find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const workspaceCwd = workspace.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can manage local runtime services" });
      return;
    }

    const runtimeConfig = workspace.runtimeConfig?.workspaceRuntime ?? null;
    if ((action === "start" || action === "restart") && !runtimeConfig) {
      res.status(422).json({ error: "Project workspace has no runtime service configuration" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperations.createRecorder({ companyId: project.companyId });
    let runtimeServiceCount = workspace.runtimeServices?.length ?? 0;
    const stdout: string[] = [];
    const stderr: string[] = [];

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: `workspace runtime ${action}`,
      cwd: workspace.cwd,
      metadata: {
        action,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
      },
      run: async () => {
        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout.push(chunk);
          else stderr.push(chunk);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForProjectWorkspace({
            db,
            projectWorkspaceId: workspace.id,
          });
        }

        if (action === "start" || action === "restart") {
          const startedServices = await startRuntimeServicesForWorkspaceControl({
            db,
            actor: {
              id: actor.agentId ?? null,
              name: actor.actorType === "user" ? "Board" : "Agent",
              companyId: project.companyId,
            },
            issue: null,
            workspace: {
              baseCwd: workspaceCwd,
              source: "project_primary",
              projectId: project.id,
              workspaceId: workspace.id,
              repoUrl: workspace.repoUrl,
              repoRef: workspace.repoRef,
              strategy: "project_primary",
              cwd: workspaceCwd,
              branchName: workspace.defaultRef ?? workspace.repoRef ?? null,
              worktreePath: null,
              warnings: [],
              created: false,
            },
            config: { workspaceRuntime: runtimeConfig },
            adapterEnv: {},
            onLog,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = 0;
        }

        await svc.updateWorkspace(project.id, workspace.id, {
          runtimeConfig: {
            desiredState: action === "stop" ? "stopped" : "running",
          },
        });

        return {
          status: "succeeded",
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          system:
            action === "stop"
              ? "Stopped project workspace runtime services.\n"
              : action === "restart"
                ? "Restarted project workspace runtime services.\n"
                : "Started project workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
          },
        };
      },
    });

    const updatedWorkspace = (await svc.listWorkspaces(project.id)).find((entry) => entry.id === workspace.id) ?? workspace;

    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: `project.workspace_runtime_${action}`,
      entityType: "project",
      entityId: project.id,
      details: {
        projectWorkspaceId: workspace.id,
        runtimeServiceCount,
      },
    });

    res.json({
      workspace: updatedWorkspace,
      operation,
    });
  });

  router.delete("/projects/:id/workspaces/:workspaceId", async (req, res) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const workspace = await svc.removeWorkspace(id, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Project workspace not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.workspace_deleted",
      entityType: "project",
      entityId: id,
      details: {
        workspaceId: workspace.id,
        name: workspace.name,
      },
    });

    res.json(workspace);
  });

  router.get("/projects/:id/files", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    res.json(await filesSvc.getSummary(id));
  });

  router.get("/projects/:id/files/tree", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const query = projectFilesPathSchema.parse(req.query);
    res.json(await filesSvc.listTree(id, query.path, query.showIgnored));
  });

  router.get("/projects/:id/files/content", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const query = projectFileReadSchema.parse(req.query);
    res.json(await filesSvc.readFile(id, query.path));
  });

  router.put("/projects/:id/files/content", validate(projectFileSaveSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.saveFile(id, req.body.path, req.body.content);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.file_saved",
      entityType: "project",
      entityId: id,
      details: { path: req.body.path },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/tree/file", validate(projectFileCreateSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.createFile(id, req.body.path);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.file_created",
      entityType: "project",
      entityId: id,
      details: { path: req.body.path },
    });
    res.status(201).json(result);
  });

  router.post("/projects/:id/files/tree/folder", validate(projectFileCreateSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.createFolder(id, req.body.path);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.folder_created",
      entityType: "project",
      entityId: id,
      details: { path: req.body.path },
    });
    res.status(201).json(result);
  });

  router.patch("/projects/:id/files/tree", validate(projectFileRenameSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.renamePath(id, req.body.path, req.body.nextPath);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.path_renamed",
      entityType: "project",
      entityId: id,
      details: { path: req.body.path, nextPath: req.body.nextPath },
    });
    res.json(result);
  });

  router.delete("/projects/:id/files/tree", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const query = projectFileDeleteSchema.parse(req.query);
    const result = await filesSvc.deletePath(id, query.path);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.path_deleted",
      entityType: "project",
      entityId: id,
      details: { path: query.path },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/branch", validate(projectFileBranchSwitchSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.switchBranch(id, req.body.branch, req.body.mode);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.branch_switched",
      entityType: "project",
      entityId: id,
      details: { branch: req.body.branch, mode: req.body.mode },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/branch/create", validate(projectFileBranchCreateSchema), async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.createBranch(id, req.body.name, req.body.startPoint);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.branch_created",
      entityType: "project",
      entityId: id,
      details: { name: req.body.name, startPoint: req.body.startPoint ?? null },
    });
    res.status(201).json(result);
  });

  router.delete("/projects/:id/files/branch", async (req, res) => {
    const id = req.params.id as string;
    const name = req.query.name as string | undefined;
    const force = req.query.force === "true";
    if (!name) {
      res.status(400).json({ error: "Branch name is required" });
      return;
    }
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.deleteBranch(id, name, force);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.branch_deleted",
      entityType: "project",
      entityId: id,
      details: { name, force },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/sync", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.sync(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.git_synced",
      entityType: "project",
      entityId: id,
      details: { status: result.status, branch: result.summary.currentBranch },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/branches/sync", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.syncBranches(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.branches_synced",
      entityType: "project",
      entityId: id,
      details: {
        status: result.status,
        branchesSynced: result.details.filter(
          (d) => d.action !== "error" && d.action !== "remote_deleted_local_remains",
        ).length,
        branchesWithDeletedUpstream: result.details.filter((d) => d.action === "remote_deleted_local_remains").length,
        errors: result.details.filter((d) => d.action === "error").length,
      },
    });
    res.json(result);
  });

  router.post("/projects/:id/files/publish-remote", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const { remoteUrl } = req.body as { remoteUrl?: string };
    if (!remoteUrl || typeof remoteUrl !== "string" || !remoteUrl.trim()) {
      res.status(400).json({ error: "remoteUrl is required" });
      return;
    }
    const result = await filesSvc.publishToRemote(id, remoteUrl.trim());
    if (result.status === "success" && project.primaryWorkspace) {
      await svc.updateWorkspace(id, project.primaryWorkspace.id, { repoUrl: remoteUrl.trim() });
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.published_to_remote",
      entityType: "project",
      entityId: id,
      details: { remoteUrl: remoteUrl.trim(), status: result.status },
    });
    res.json(result);
  });

  router.get("/projects/:id/files/git-status", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.getGitStatus(id);
    res.json(result);
  });

  router.post("/projects/:id/files/git-stage", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const { paths } = req.body as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths array is required" }); return;
    }
    const result = await filesSvc.stageFiles(id, paths.map(String));
    res.json(result);
  });

  router.post("/projects/:id/files/git-unstage", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const { paths } = req.body as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths array is required" }); return;
    }
    const result = await filesSvc.unstageFiles(id, paths.map(String));
    res.json(result);
  });

  router.post("/projects/:id/files/git-commit", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const { message } = req.body as { message?: string };
    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "message is required" }); return;
    }
    const result = await filesSvc.commitStaged(id, message);
    res.json(result);
  });

  router.get("/projects/:id/files/git-diff", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const filePath = req.query.path as string | undefined;
    if (!filePath) { res.status(400).json({ error: "path is required" }); return; }
    const staged = req.query.staged === "true";
    const result = await filesSvc.getFileDiff(id, filePath, staged);
    res.json(result);
  });

  router.post("/projects/:id/files/git-discard", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const { paths } = req.body as { paths?: unknown };
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths array is required" }); return;
    }
    const result = await filesSvc.discardFiles(id, paths.map(String));
    res.json(result);
  });

  router.post("/projects/:id/files/git-push", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertBoard(req);
    assertCompanyAccess(req, project.companyId);
    const result = await filesSvc.pushFiles(id);
    res.json(result);
  });

  router.delete("/projects/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const project = await svc.remove(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.deleted",
      entityType: "project",
      entityId: project.id,
    });

    res.json(project);
  });

  return router;
}
