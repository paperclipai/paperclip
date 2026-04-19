import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { githubService } from "../services/github.js";
import { projectService } from "../services/projects.js";
import { forbidden, badRequest } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity } from "../services/activity-log.js";

/**
 * GitHub file routes — proxy GitHub Contents API through Paperclip auth.
 *
 * GET  /projects/:projectId/files/*filePath  — read a file
 * PUT  /projects/:projectId/files/*filePath  — create or update a file
 * GET  /projects/:projectId/tree/*dirPath    — list directory contents
 */
export function githubFileRoutes(db: Db) {
  const router = Router();
  const github = githubService(db);
  const projects = projectService(db);

  /** Middleware: resolve project and assert company access */
  async function resolveProject(req: import("express").Request) {
    const projectId = req.params.projectId as string;
    const project = await projects.getById(projectId);
    if (!project) throw badRequest("Project not found");
    assertCompanyAccess(req, project.companyId);
    return { projectId, companyId: project.companyId };
  }

  /**
   * GET /projects/:projectId/files/*filePath
   *
   * Returns: { name, path, sha, size, content, encoding, htmlUrl }
   * Query: ?ref=branch-or-sha (optional)
   */
  router.get("/projects/:projectId/files/*filePath", async (req, res) => {
    if (req.actor.type === "none") throw forbidden("Authentication required");

    const { projectId, companyId } = await resolveProject(req);
    const filePath = Array.isArray(req.params.filePath)
      ? req.params.filePath.join("/")
      : (req.params.filePath as string);
    const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;

    const file = await github.getFile(projectId, filePath, ref);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github.file.read",
      entityType: "project",
      entityId: projectId,
      details: { filePath, ref },
    });

    res.json(file);
  });

  /**
   * PUT /projects/:projectId/files/*filePath
   *
   * Body: { content: string, message: string, sha?: string, branch?: string }
   * - sha is required when updating an existing file (conflict detection)
   * - message is the commit message
   *
   * Returns: { path, sha, commitSha, htmlUrl }
   * 409 if sha doesn't match (version conflict)
   */
  router.put("/projects/:projectId/files/*filePath", async (req, res) => {
    if (req.actor.type === "none") throw forbidden("Authentication required");

    const { projectId, companyId } = await resolveProject(req);
    const filePath = Array.isArray(req.params.filePath)
      ? req.params.filePath.join("/")
      : (req.params.filePath as string);

    const { content, message, sha, branch } = req.body as {
      content?: string;
      message?: string;
      sha?: string;
      branch?: string;
    };

    if (content === undefined || content === null) {
      throw badRequest("content is required");
    }
    if (!message || !message.trim()) {
      throw badRequest("message (commit message) is required");
    }

    const result = await github.putFile(projectId, filePath, {
      content,
      message: message.trim(),
      sha,
      branch,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github.file.write",
      entityType: "project",
      entityId: projectId,
      details: { filePath, commitSha: result.commitSha, branch },
    });

    res.json(result);
  });

  /**
   * GET /projects/:projectId/tree/*dirPath
   *
   * Returns: Array<{ name, path, type, sha, size }>
   * Query: ?ref=branch-or-sha (optional)
   */
  router.get("/projects/:projectId/tree/*dirPath", async (req, res) => {
    if (req.actor.type === "none") throw forbidden("Authentication required");

    const { projectId, companyId } = await resolveProject(req);
    const dirPath = Array.isArray(req.params.dirPath)
      ? req.params.dirPath.join("/")
      : (req.params.dirPath as string) || "";
    const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;

    const files = await github.listFiles(projectId, dirPath, ref);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github.tree.read",
      entityType: "project",
      entityId: projectId,
      details: { dirPath, ref },
    });

    res.json(files);
  });

  /** Also support tree root without trailing path */
  router.get("/projects/:projectId/tree", async (req, res) => {
    if (req.actor.type === "none") throw forbidden("Authentication required");

    const { projectId, companyId } = await resolveProject(req);
    const ref = typeof req.query.ref === "string" ? req.query.ref : undefined;

    const files = await github.listFiles(projectId, "", ref);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github.tree.read",
      entityType: "project",
      entityId: projectId,
      details: { dirPath: "", ref },
    });

    res.json(files);
  });

  return router;
}
