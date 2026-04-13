import { Router, type Request } from "express";
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import {
  createProjectSchema,
  createProjectWorkspaceSchema,
  isUuidLike,
  updateProjectSchema,
  updateProjectWorkspaceSchema,
} from "@paperclipai/shared";
import { trackProjectCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { projectService, logActivity, secretService, workspaceOperationService } from "../services/index.js";
import { conflict } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { startRuntimeServicesForWorkspaceControl, stopRuntimeServicesForProjectWorkspace } from "../services/workspace-runtime.js";
import { getTelemetryClient } from "../telemetry.js";

export function projectRoutes(db: Db) {
  const router = Router();
  const svc = projectService(db);
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

  // Live git branch for a workspace — reads from disk, not the database.
  const execFileAsync = promisify(execFile);
  router.get("/workspaces/:workspaceId/git-info", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await svc.getWorkspaceById(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    const project = await svc.getById(workspace.projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    assertCompanyAccess(req, project.companyId);

    const cwd = workspace.cwd;
    if (!cwd) {
      res.json({ branch: null, dirty: false });
      return;
    }

    try {
      const [branchResult, statusResult] = await Promise.all([
        execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 }),
        execFileAsync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd, timeout: 5000 }),
      ]);
      res.json({
        branch: branchResult.stdout.trim() || null,
        dirty: statusResult.stdout.trim().length > 0,
      });
    } catch {
      res.json({ branch: null, dirty: false });
    }
  });

  // ── Git operations for workspaces ─────────────────────────────────
  // All endpoints resolve the workspace cwd and run git commands on disk.

  async function resolveWorkspaceCwd(req: Request, workspaceId: string): Promise<string> {
    const workspace = await svc.getWorkspaceById(workspaceId);
    if (!workspace) { throw Object.assign(new Error("Workspace not found"), { status: 404 }); }
    const project = await svc.getById(workspace.projectId);
    if (!project) { throw Object.assign(new Error("Project not found"), { status: 404 }); }
    assertCompanyAccess(req, project.companyId);
    if (!workspace.cwd) { throw Object.assign(new Error("Workspace has no local path"), { status: 422 }); }
    return workspace.cwd;
  }

  // GET /workspaces/:id/git-status — file-level staged/unstaged/untracked
  router.get("/workspaces/:workspaceId/git-status", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-uall"], { cwd, timeout: 10000 });
      const staged: Array<{ path: string; status: string }> = [];
      const unstaged: Array<{ path: string; status: string }> = [];

      for (const line of stdout.split("\n")) {
        if (!line || line.length < 4) continue;
        const x = line[0]!; // index status
        const y = line[1]!; // worktree status
        // Handle renames: "R  old -> new"
        const rawPath = line.slice(3);
        const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop()! : rawPath;

        if (x === "?" && y === "?") {
          unstaged.push({ path: filePath, status: "?" });
        } else {
          if (x !== " " && x !== "?") staged.push({ path: filePath, status: x });
          if (y !== " " && y !== "?") unstaged.push({ path: filePath, status: y });
        }
      }

      res.json({ staged, unstaged });
    } catch {
      res.json({ staged: [], unstaged: [] });
    }
  });

  // GET /workspaces/:id/git-diff?path=...&staged=true/false
  router.get("/workspaces/:workspaceId/git-diff", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: "path query param required" }); return; }
    const staged = req.query.staged === "true";

    try {
      const args = staged
        ? ["diff", "--cached", "--", filePath]
        : ["diff", "--", filePath];
      const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10000 });

      // For untracked files, git diff returns nothing — read the file instead
      if (!stdout && !staged) {
        try {
          const showResult = await execFileAsync("git", ["diff", "--no-index", "/dev/null", filePath], { cwd, timeout: 5000 });
          res.json({ diff: showResult.stdout });
          return;
        } catch (e: any) {
          // git diff --no-index exits with 1 when there are differences (expected)
          if (e.stdout) { res.json({ diff: e.stdout }); return; }
        }
      }

      res.json({ diff: stdout });
    } catch {
      res.json({ diff: "" });
    }
  });

  // POST /workspaces/:id/git-stage — stage files
  router.post("/workspaces/:workspaceId/git-stage", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths array required" }); return;
    }
    if (paths.length > 500) {
      res.status(400).json({ error: "Too many paths (max 500)" }); return;
    }

    try {
      await execFileAsync("git", ["add", "--", ...paths], { cwd, timeout: 10000 });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "git add failed" });
    }
  });

  // POST /workspaces/:id/git-unstage — unstage files
  router.post("/workspaces/:workspaceId/git-unstage", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      res.status(400).json({ error: "paths array required" }); return;
    }

    try {
      await execFileAsync("git", ["reset", "HEAD", "--", ...paths], { cwd, timeout: 10000 });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "git reset failed" });
    }
  });

  // POST /workspaces/:id/git-commit — commit staged changes
  router.post("/workspaces/:workspaceId/git-commit", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    const message = req.body?.message;
    if (typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "commit message required" }); return;
    }

    try {
      const { stdout } = await execFileAsync("git", ["commit", "-m", message], { cwd, timeout: 15000 });
      const summary = stdout.split("\n")[0] ?? "";
      res.json({ ok: true, summary });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "git commit failed" });
    }
  });

  // ── File browser for workspaces ────────────────────────────────────
  // GET /workspaces/:id/files?path=<subdir> — list directory contents

  router.get("/workspaces/:workspaceId/files", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    const subPath = (req.query.path as string) || "";
    const targetDir = subPath ? join(cwd, subPath) : cwd;

    // Prevent path traversal
    const resolved = join(targetDir);
    if (!resolved.startsWith(cwd)) {
      res.status(400).json({ error: "Path traversal not allowed" });
      return;
    }

    try {
      const entries = await readdir(targetDir, { withFileTypes: true });
      const files: Array<{ name: string; path: string; type: "file" | "directory"; size?: number }> = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue; // skip hidden files
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const entryPath = subPath ? `${subPath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push({ name: entry.name, path: entryPath, type: "directory" });
        } else if (entry.isFile()) {
          try {
            const s = await stat(join(targetDir, entry.name));
            files.push({ name: entry.name, path: entryPath, type: "file", size: s.size });
          } catch {
            files.push({ name: entry.name, path: entryPath, type: "file" });
          }
        }
      }

      // Sort: directories first, then alphabetical
      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.json({ path: subPath || ".", files });
    } catch (err: any) {
      if (err.code === "ENOENT") {
        res.status(404).json({ error: "Directory not found" });
      } else {
        res.status(500).json({ error: err.message ?? "Failed to list files" });
      }
    }
  });

  // ── PR status for workspaces ──────────────────────────────────────
  // GET /workspaces/:id/pr-status — get open PR + CI checks from GitHub

  router.get("/workspaces/:workspaceId/pr-status", async (req, res) => {
    let cwd: string;
    try { cwd = await resolveWorkspaceCwd(req, req.params.workspaceId as string); }
    catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); return; }

    try {
      // Get current branch
      const { stdout: branchOut } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 5000 });
      const branch = branchOut.trim();

      // Get remote URL to determine owner/repo
      let remoteUrl = "";
      try {
        const { stdout: remoteOut } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd, timeout: 5000 });
        remoteUrl = remoteOut.trim();
      } catch {
        res.json({ branch, pr: null, checks: [], error: "No remote configured" });
        return;
      }

      // Parse owner/repo from remote URL
      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (!match) {
        res.json({ branch, pr: null, checks: [], error: "Not a GitHub remote" });
        return;
      }
      const [, owner, repo] = match;

      // Use gh CLI to get PR info for current branch
      try {
        const { stdout: prJson } = await execFileAsync("gh", [
          "pr", "view", "--json",
          "number,title,state,url,headRefName,baseRefName,additions,deletions,reviewDecision,statusCheckRollup,body",
        ], { cwd, timeout: 15000 });

        const pr = JSON.parse(prJson);
        const checks = (pr.statusCheckRollup ?? []).map((check: any) => ({
          name: check.name ?? check.context ?? "Unknown",
          status: check.status ?? check.state ?? "unknown",
          conclusion: check.conclusion ?? null,
          url: check.detailsUrl ?? check.targetUrl ?? null,
        }));

        res.json({
          branch,
          pr: {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            url: pr.url,
            head: pr.headRefName,
            base: pr.baseRefName,
            additions: pr.additions,
            deletions: pr.deletions,
            reviewDecision: pr.reviewDecision,
            body: (pr.body ?? "").slice(0, 2000),
          },
          checks,
        });
      } catch {
        // No PR for this branch
        res.json({ branch, pr: null, checks: [] });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? "Failed to get PR status" });
    }
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
