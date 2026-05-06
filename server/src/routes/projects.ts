import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { and, desc, eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  findWorkspaceCommandDefinition,
  isUuidLike,
  matchWorkspaceRuntimeServiceToCommand,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
  workspaceRuntimeControlTargetSchema,
} from "@paperclipai/shared";
import type { WorkspaceRuntimeDesiredState, WorkspaceRuntimeServiceStateMap } from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { projectProgressSyncService, projectService, logActivity, workspaceOperationService, workProductService } from "../services/index.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  buildWorkspaceRuntimeDesiredStatePatch,
  listConfiguredRuntimeServiceEntries,
  runWorkspaceJobForControl,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForProjectWorkspace,
} from "../services/workspace-runtime.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectProjectExecutionWorkspaceCommandPaths,
  collectProjectWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { assertCanManageProjectWorkspaceRuntimeServices } from "./workspace-runtime-service-authz.js";
import { getTelemetryClient } from "../telemetry.js";
import { appendWithCap } from "../adapters/utils.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { environmentService } from "../services/environments.js";
import { secretService } from "../services/secrets.js";
import {
  WorkspaceFileBrowserError,
  listWorkspaceFiles,
  readWorkspaceFileContent,
  resolveWorkspaceFileForDownload,
} from "../services/workspace-file-browser.js";

const WORKSPACE_CONTROL_OUTPUT_MAX_CHARS = 256 * 1024;
const SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS = new Set(["stop", "restart"]);
const execFile = promisify(execFileCallback);
const COMMAND_OUTPUT_MAX_BUFFER = 512 * 1024;

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
  const workProducts = workProductService(db);
  const projectProgressSync = projectProgressSyncService(db);
  const secretsSvc = secretService(db);
  const workspaceOperations = workspaceOperationService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";
  const environmentsSvc = environmentService(db);

  async function assertProjectEnvironmentSelection(companyId: string, environmentId: string | null | undefined) {
    if (environmentId === undefined || environmentId === null) return;
    await assertEnvironmentSelectionForCompany(environmentsSvc, companyId, environmentId, {
      allowedDrivers: ["local", "ssh", "sandbox"],
    });
  }

  function readProjectPolicyEnvironmentId(policy: unknown): string | null | undefined {
    if (!policy || typeof policy !== "object" || !("environmentId" in policy)) {
      return undefined;
    }
    const environmentId = (policy as { environmentId?: unknown }).environmentId;
    return typeof environmentId === "string" || environmentId === null ? environmentId : undefined;
  }

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
    if (!companyId) throw notFound("Project not found");
    const resolved = await svc.resolveByReference(companyId, rawId);
    if (resolved.ambiguous) {
      throw conflict("Project shortname is ambiguous in this company. Use the project ID.");
    }
    if (!resolved.project) throw notFound("Project not found");
    return resolved.project.id;
  }

  function tryHandleWorkspaceBrowserError(res: Response, error: unknown) {
    if (error instanceof WorkspaceFileBrowserError) {
      res.status(error.status).json({ error: error.message });
      return true;
    }
    return false;
  }

  function readWorkspaceBrowserPath(req: Request) {
    const pathQuery = req.query.path;
    return typeof pathQuery === "string" ? pathQuery : "";
  }

  function resolveProjectWorkspaceBrowserRoot(project: NonNullable<Awaited<ReturnType<typeof svc.getById>>>, workspaceId: string, cwd: string | null) {
    return cwd ?? (project.codebase.workspaceId === workspaceId ? project.codebase.effectiveLocalFolder : null);
  }

  async function pathExists(pathValue: string | null | undefined) {
    if (!pathValue) return false;
    return fs.access(pathValue).then(() => true, () => false);
  }

  async function runCommand(command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
    try {
      const result = await execFile(command, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: 60_000,
        maxBuffer: COMMAND_OUTPUT_MAX_BUFFER,
      });
      return {
        ok: true as const,
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
      };
    } catch (error) {
      const err = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number | string };
      return {
        ok: false as const,
        code: err.code ?? null,
        stdout: err.stdout?.toString() ?? "",
        stderr: err.stderr?.toString() ?? err.message,
      };
    }
  }

  async function readGitIntegrationStatus(project: NonNullable<Awaited<ReturnType<typeof svc.getById>>>) {
    const rootPath = project.codebase.effectiveLocalFolder;
    const localPathAvailable = await pathExists(rootPath);
    const base = {
      connected: Boolean(project.codebase.repoUrl),
      repoUrl: project.codebase.repoUrl,
      repoName: project.codebase.repoName,
      rootPath,
      localPathAvailable,
      isGitCheckout: false,
      branch: null as string | null,
      commitSha: null as string | null,
      remoteUrl: null as string | null,
      upstream: null as string | null,
      ahead: null as number | null,
      behind: null as number | null,
      dirty: null as boolean | null,
      synced: false,
      status: localPathAvailable ? "not_git_checkout" : "missing_local_path",
      message: localPathAvailable ? "Local path exists but is not a Git checkout." : "Local project files are not available on this host yet.",
    };
    if (!localPathAvailable) return base;

    const inside = await runCommand("git", ["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.trim() !== "true") return base;

    const [branch, commit, remote, upstream, porcelain] = await Promise.all([
      runCommand("git", ["-C", rootPath, "branch", "--show-current"]),
      runCommand("git", ["-C", rootPath, "rev-parse", "HEAD"]),
      runCommand("git", ["-C", rootPath, "remote", "get-url", "origin"]),
      runCommand("git", ["-C", rootPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
      runCommand("git", ["-C", rootPath, "status", "--porcelain"]),
    ]);
    let ahead: number | null = null;
    let behind: number | null = null;
    const upstreamName = upstream.ok ? upstream.stdout.trim() || null : null;
    if (upstreamName) {
      const counts = await runCommand("git", ["-C", rootPath, "rev-list", "--left-right", "--count", `${upstreamName}...HEAD`]);
      if (counts.ok) {
        const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
        behind = Number.isFinite(Number(behindRaw)) ? Number(behindRaw) : null;
        ahead = Number.isFinite(Number(aheadRaw)) ? Number(aheadRaw) : null;
      }
    }
    const dirty = porcelain.ok ? porcelain.stdout.trim().length > 0 : null;
    const synced = Boolean(project.codebase.repoUrl) && dirty === false && (ahead ?? 0) === 0;
    return {
      ...base,
      isGitCheckout: true,
      branch: branch.ok ? branch.stdout.trim() || null : null,
      commitSha: commit.ok ? commit.stdout.trim() || null : null,
      remoteUrl: remote.ok ? remote.stdout.trim() || null : null,
      upstream: upstreamName,
      ahead,
      behind,
      dirty,
      synced,
      status: synced ? "synced" : "needs_sync",
      message: synced
        ? "Local checkout is clean and has no unpushed commits."
        : "Local checkout has uncommitted changes, unpushed commits, or no upstream tracking branch.",
    };
  }

  async function readVercelIntegrationStatus(companyId: string, projectId: string) {
    const products = await workProducts.listForProject(companyId, projectId);
    const deployments = products.filter((product) => {
      const provider = product.provider.toLowerCase();
      const url = product.url?.toLowerCase() ?? "";
      return provider.includes("vercel") || url.includes("vercel.app");
    });
    const latestActivityDeployment = await db
      .select({ details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "project"),
          eq(activityLog.entityId, projectId),
          eq(activityLog.action, "project.vercel_deployed"),
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const activityDeploymentUrl =
      latestActivityDeployment?.details && typeof latestActivityDeployment.details === "object"
        ? (latestActivityDeployment.details as Record<string, unknown>).deploymentUrl
        : null;
    const latest = deployments[0] ?? (
      typeof activityDeploymentUrl === "string" && activityDeploymentUrl.trim().length > 0
        ? {
            id: `activity:${latestActivityDeployment!.createdAt.toISOString()}`,
            companyId,
            projectId,
            issueId: null,
            executionWorkspaceId: null,
            runtimeServiceId: null,
            type: "preview_url",
            provider: "vercel",
            externalId: null,
            title: "Vercel deployment",
            url: activityDeploymentUrl,
            status: "deployed",
            reviewState: "not_requested",
            isPrimary: true,
            healthStatus: null,
            summary: "Deployment triggered by Paperclip automation.",
            metadata: null,
            createdByRunId: null,
            createdAt: latestActivityDeployment!.createdAt,
            updatedAt: latestActivityDeployment!.createdAt,
            issueTitle: "Project deployment",
            issueIdentifier: null,
            issueStatus: "done",
          }
        : null
    );
    return {
      deployed: Boolean(latest?.url),
      latestDeployment: latest,
      deploymentCount: deployments.length,
      hasToken: Boolean(process.env.VERCEL_TOKEN),
      status: latest?.url ? "deployed" : "not_deployed",
      message: latest?.url
        ? "Latest Vercel deployment was found in project work products."
        : "No Vercel deployment URL is attached to this project yet.",
    };
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

  router.get("/projects/:id/work-products", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    res.json(await workProducts.listForProject(project.companyId, project.id));
  });

  router.get("/projects/:id/integration-status", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    const [github, vercel] = await Promise.all([
      readGitIntegrationStatus(project),
      readVercelIntegrationStatus(project.companyId, project.id),
    ]);
    res.json({ github, vercel });
  });

  router.post("/projects/:id/github/:action", async (req, res) => {
    const id = req.params.id as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "pull" && action !== "push" && action !== "sync-progress") {
      res.status(404).json({ error: "GitHub action not found" });
      return;
    }
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only the board can run project GitHub sync actions" });
      return;
    }
    if (action === "sync-progress") {
      const result = await projectProgressSync.syncProjectProgressToGitHub(project.id, {
        reason: "manual_project_system_action",
        force: true,
      });
      if (result.status === "failed") {
        res.status(422).json({ error: result.message, result, github: await readGitIntegrationStatus(project) });
        return;
      }
      res.json({ action, result, stdout: "", stderr: "", github: await readGitIntegrationStatus(project) });
      return;
    }
    const status = await readGitIntegrationStatus(project);
    if (!status.localPathAvailable || !status.isGitCheckout) {
      res.status(422).json({ error: "Project codebase is not available as a local Git checkout" });
      return;
    }
    const result = action === "pull"
      ? await runCommand("git", ["-C", status.rootPath, "pull", "--ff-only"])
      : await runCommand("git", ["-C", status.rootPath, "push"]);
    if (!result.ok) {
      res.status(422).json({ error: result.stderr || result.stdout || `git ${action} failed`, stdout: result.stdout, stderr: result.stderr });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: `project.github_${action}`,
      entityType: "project",
      entityId: project.id,
      details: {
        rootPath: status.rootPath,
        branch: status.branch,
        repoUrl: status.repoUrl,
      },
    });

    res.json({ action, stdout: result.stdout, stderr: result.stderr, github: await readGitIntegrationStatus(project) });
  });

  router.post("/projects/:id/vercel/deploy", async (req, res) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only the board can deploy projects to Vercel" });
      return;
    }
    const rootPath = project.codebase.effectiveLocalFolder;
    if (!await pathExists(rootPath)) {
      res.status(422).json({ error: "Project codebase is not available on this host yet" });
      return;
    }
    if (!process.env.VERCEL_TOKEN) {
      res.status(422).json({ error: "VERCEL_TOKEN is required before Paperclip can deploy this project to Vercel" });
      return;
    }
    const prod = Boolean((req.body as { production?: unknown } | undefined)?.production);
    const args = ["deploy", "--yes", "--token", process.env.VERCEL_TOKEN, ...(prod ? ["--prod"] : [])];
    const result = await runCommand("vercel", args, { cwd: rootPath, env: process.env });
    if (!result.ok) {
      res.status(422).json({ error: result.stderr || result.stdout || "Vercel deploy failed", stdout: result.stdout, stderr: result.stderr });
      return;
    }
    const deploymentUrl = [...result.stdout.matchAll(/https:\/\/[^\s]+/g)].map((match) => match[0]).at(-1) ?? null;

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: project.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "project.vercel_deployed",
      entityType: "project",
      entityId: project.id,
      details: {
        rootPath,
        production: prod,
        deploymentUrl,
      },
    });

    res.json({ deploymentUrl, stdout: result.stdout, stderr: result.stderr, vercel: await readVercelIntegrationStatus(project.companyId, project.id) });
  });

  router.get("/projects/:id/codebase/files", async (req, res, next) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    try {
      res.json(
        await listWorkspaceFiles({
          workspaceKind: "project_codebase",
          workspaceId: project.id,
          workspaceName: `${project.name} codebase`,
          rootPath: project.codebase.effectiveLocalFolder,
          relativePath: readWorkspaceBrowserPath(req),
        }),
      );
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.get("/projects/:id/codebase/file-content", async (req, res, next) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    try {
      res.json(
        await readWorkspaceFileContent({
          workspaceKind: "project_codebase",
          workspaceId: project.id,
          workspaceName: `${project.name} codebase`,
          rootPath: project.codebase.effectiveLocalFolder,
          relativePath: readWorkspaceBrowserPath(req),
        }),
      );
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.get("/projects/:id/codebase/file-raw", async (req, res, next) => {
    const id = req.params.id as string;
    const project = await svc.getById(id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);
    try {
      const file = await resolveWorkspaceFileForDownload({
        rootPath: project.codebase.effectiveLocalFolder,
        relativePath: readWorkspaceBrowserPath(req),
      });
      if (file.contentType) res.type(file.contentType);
      res.sendFile(file.absolutePath);
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.get("/projects/:id/workspaces/:workspaceId/files", async (req, res, next) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
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
    const rootPath = resolveProjectWorkspaceBrowserRoot(project, workspace.id, workspace.cwd);
    if (!rootPath) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can browse files" });
      return;
    }

    try {
      res.json(
        await listWorkspaceFiles({
          workspaceKind: "project_workspace",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          rootPath,
          relativePath: readWorkspaceBrowserPath(req),
        }),
      );
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.get("/projects/:id/workspaces/:workspaceId/file-content", async (req, res, next) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
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
    const rootPath = resolveProjectWorkspaceBrowserRoot(project, workspace.id, workspace.cwd);
    if (!rootPath) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can browse files" });
      return;
    }

    try {
      res.json(
        await readWorkspaceFileContent({
          workspaceKind: "project_workspace",
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          rootPath,
          relativePath: readWorkspaceBrowserPath(req),
        }),
      );
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.get("/projects/:id/workspaces/:workspaceId/file-raw", async (req, res, next) => {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
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
    const rootPath = resolveProjectWorkspaceBrowserRoot(project, workspace.id, workspace.cwd);
    if (!rootPath) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can browse files" });
      return;
    }

    try {
      const file = await resolveWorkspaceFileForDownload({
        rootPath,
        relativePath: readWorkspaceBrowserPath(req),
      });
      if (file.contentType) res.type(file.contentType);
      res.sendFile(file.absolutePath);
    } catch (error) {
      if (!tryHandleWorkspaceBrowserError(res, error)) next(error);
    }
  });

  router.post("/companies/:companyId/projects", validate(createProjectSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    type CreateProjectPayload = Parameters<typeof svc.create>[1] & {
      workspace?: Parameters<typeof svc.createWorkspace>[1];
    };

    const { workspace, ...projectData } = req.body as CreateProjectPayload;
    await assertProjectEnvironmentSelection(
      companyId,
      readProjectPolicyEnvironmentId(projectData.executionWorkspacePolicy),
    );
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      [
        ...collectProjectExecutionWorkspaceCommandPaths(projectData.executionWorkspacePolicy),
        ...collectProjectWorkspaceCommandPaths(workspace, "workspace"),
      ],
    );
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
    }
    const hydratedProject = workspace ? await svc.getById(project.id) : project;

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
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectExecutionWorkspaceCommandPaths(body.executionWorkspacePolicy),
    );
    await assertProjectEnvironmentSelection(
      existing.companyId,
      readProjectPolicyEnvironmentId(body.executionWorkspacePolicy),
    );
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
    assertNoAgentHostWorkspaceCommandMutation(
      req,
      collectProjectWorkspaceCommandPaths(req.body),
    );
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
      assertNoAgentHostWorkspaceCommandMutation(
        req,
        collectProjectWorkspaceCommandPaths(req.body),
      );
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

  async function handleProjectWorkspaceRuntimeCommand(req: Request, res: Response) {
    const id = req.params.id as string;
    const workspaceId = req.params.workspaceId as string;
    const action = String(req.params.action ?? "").trim().toLowerCase();
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "run") {
      res.status(404).json({ error: "Workspace command action not found" });
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

    const isSharedWorkspace = Boolean(workspace.sharedWorkspaceKey);
    if (
      req.actor.type === "agent"
      && isSharedWorkspace
      && SHARED_WORKSPACE_STOP_AND_RESTART_ACTIONS.has(action)
    ) {
      throw forbidden("Missing permission to manage workspace runtime services");
    }

    await assertCanManageProjectWorkspaceRuntimeServices(db, req, {
      companyId: project.companyId,
      projectWorkspaceId: workspace.id,
    });

    const workspaceCwd = workspace.cwd;
    if (!workspaceCwd) {
      res.status(422).json({ error: "Project workspace needs a local path before Paperclip can run workspace commands" });
      return;
    }

    const runtimeConfig = workspace.runtimeConfig?.workspaceRuntime ?? null;
    const target = req.body as { workspaceCommandId?: string | null; runtimeServiceId?: string | null; serviceIndex?: number | null };
    const configuredServices = runtimeConfig ? listConfiguredRuntimeServiceEntries({ workspaceRuntime: runtimeConfig }) : [];
    const workspaceCommand = runtimeConfig
      ? findWorkspaceCommandDefinition(runtimeConfig, target.workspaceCommandId ?? null)
      : null;
    if (target.workspaceCommandId && !workspaceCommand) {
      res.status(404).json({ error: "Workspace command not found for this project workspace" });
      return;
    }
    if (target.runtimeServiceId && !(workspace.runtimeServices ?? []).some((service) => service.id === target.runtimeServiceId)) {
      res.status(404).json({ error: "Runtime service not found for this project workspace" });
      return;
    }
    const matchedRuntimeService =
      workspaceCommand?.kind === "service" && !target.runtimeServiceId
        ? matchWorkspaceRuntimeServiceToCommand(workspaceCommand, workspace.runtimeServices ?? [])
        : null;
    const selectedRuntimeServiceId = target.runtimeServiceId ?? matchedRuntimeService?.id ?? null;
    const selectedServiceIndex =
      workspaceCommand?.kind === "service"
        ? workspaceCommand.serviceIndex
        : target.serviceIndex ?? null;
    if (
      selectedServiceIndex !== undefined
      && selectedServiceIndex !== null
      && (selectedServiceIndex < 0 || selectedServiceIndex >= configuredServices.length)
    ) {
      res.status(422).json({ error: "Selected runtime service is not defined in this project workspace runtime config" });
      return;
    }
    if (workspaceCommand?.kind === "job" && action !== "run") {
      res.status(422).json({ error: `Workspace job "${workspaceCommand.name}" can only be run` });
      return;
    }
    if (workspaceCommand?.kind === "service" && action === "run") {
      res.status(422).json({ error: `Workspace service "${workspaceCommand.name}" should be started or restarted, not run` });
      return;
    }
    if (action === "run" && !workspaceCommand) {
      res.status(422).json({ error: "Select a workspace job to run" });
      return;
    }
    if ((action === "start" || action === "restart") && !runtimeConfig) {
      res.status(422).json({ error: "Project workspace has no workspace command configuration" });
      return;
    }

    const actor = getActorInfo(req);
    const recorder = workspaceOperations.createRecorder({ companyId: project.companyId });
    let runtimeServiceCount = workspace.runtimeServices?.length ?? 0;
    let stdout = "";
    let stderr = "";

    const operation = await recorder.recordOperation({
      phase: action === "stop" ? "workspace_teardown" : "workspace_provision",
      command: workspaceCommand?.command ?? `workspace command ${action}`,
      cwd: workspace.cwd,
      metadata: {
        action,
        projectId: project.id,
        projectWorkspaceId: workspace.id,
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
      run: async () => {
        if (action === "run") {
          if (!workspaceCommand || workspaceCommand.kind !== "job") {
            throw new Error("Workspace job selection is required");
          }
          return await runWorkspaceJobForControl({
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
            command: workspaceCommand.rawConfig,
            adapterEnv: {},
            recorder,
            metadata: {
              action,
              projectId: project.id,
              projectWorkspaceId: workspace.id,
              workspaceCommandId: workspaceCommand.id,
            },
          }).then((nestedOperation) => ({
            status: "succeeded" as const,
            exitCode: 0,
            metadata: {
              nestedOperationId: nestedOperation?.id ?? null,
              runtimeServiceCount,
            },
          }));
        }

        const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
          if (stream === "stdout") stdout = appendWithCap(stdout, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
          else stderr = appendWithCap(stderr, chunk, WORKSPACE_CONTROL_OUTPUT_MAX_CHARS);
        };

        if (action === "stop" || action === "restart") {
          await stopRuntimeServicesForProjectWorkspace({
            db,
            projectWorkspaceId: workspace.id,
            runtimeServiceId: selectedRuntimeServiceId,
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
            serviceIndex: selectedServiceIndex,
          });
          runtimeServiceCount = startedServices.length;
        } else {
          runtimeServiceCount = selectedRuntimeServiceId ? Math.max(0, (workspace.runtimeServices?.length ?? 1) - 1) : 0;
        }

        const currentDesiredState: WorkspaceRuntimeDesiredState =
          workspace.runtimeConfig?.desiredState
          ?? ((workspace.runtimeServices ?? []).some((service) => service.status === "starting" || service.status === "running")
            ? "running"
            : "stopped");
        const nextRuntimeState: {
          desiredState: WorkspaceRuntimeDesiredState;
          serviceStates: WorkspaceRuntimeServiceStateMap | null | undefined;
        } = selectedRuntimeServiceId && (selectedServiceIndex === undefined || selectedServiceIndex === null)
          ? {
              desiredState: currentDesiredState,
              serviceStates: workspace.runtimeConfig?.serviceStates ?? null,
            }
          : buildWorkspaceRuntimeDesiredStatePatch({
              config: { workspaceRuntime: runtimeConfig },
              currentDesiredState,
              currentServiceStates: workspace.runtimeConfig?.serviceStates ?? null,
              action,
              serviceIndex: selectedServiceIndex,
            });
        await svc.updateWorkspace(project.id, workspace.id, {
          runtimeConfig: {
            desiredState: nextRuntimeState.desiredState,
            serviceStates: nextRuntimeState.serviceStates,
          },
        });

        return {
          status: "succeeded",
          stdout,
          stderr,
          system:
            action === "stop"
              ? "Stopped project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
              : action === "restart"
                ? "Restarted project workspace runtime services.\nThis does not pause issue work or held wake scheduling."
                : "Started project workspace runtime services.\n",
          metadata: {
            runtimeServiceCount,
            workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
            runtimeServiceId: selectedRuntimeServiceId,
            serviceIndex: selectedServiceIndex,
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
        workspaceCommandId: workspaceCommand?.id ?? target.workspaceCommandId ?? null,
        workspaceCommandKind: workspaceCommand?.kind ?? null,
        workspaceCommandName: workspaceCommand?.name ?? null,
        runtimeServiceId: selectedRuntimeServiceId,
        serviceIndex: selectedServiceIndex,
      },
    });

    res.json({
      workspace: updatedWorkspace,
      operation,
    });
  }

  router.post("/projects/:id/workspaces/:workspaceId/runtime-services/:action", validate(workspaceRuntimeControlTargetSchema), handleProjectWorkspaceRuntimeCommand);
  router.post("/projects/:id/workspaces/:workspaceId/runtime-commands/:action", validate(workspaceRuntimeControlTargetSchema), handleProjectWorkspaceRuntimeCommand);

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
