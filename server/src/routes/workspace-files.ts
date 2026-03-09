import { Router } from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import archiver from "archiver";

const execFileAsync = promisify(execFile);
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { projectService } from "../services/index.js";
import { REPO_ONLY_CWD_SENTINEL } from "../services/projects.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Resolves and validates a path within the workspace root.
 *
 * Uses `path.resolve` to normalise the combined path, then verifies that the
 * result is a strict descendant of the root (not the root itself). This
 * prevents directory traversal attacks (e.g. `../../etc/passwd`) and also
 * prevents operations on the workspace root directory itself.
 *
 * @param workspaceRoot - Absolute path to the workspace root directory.
 * @param relativePath  - Client-supplied path to resolve against the root.
 * @returns The absolute, validated path.
 * @throws An HTTP 400 error if the resolved path escapes the workspace root
 *         or resolves to the workspace root directory itself.
 */
function resolveSafePath(workspaceRoot: string, relativePath: string): string {
  // Normalize the workspace root to remove any trailing slash
  const root = path.resolve(workspaceRoot);
  // Resolve the relative path against the root
  const resolved = path.resolve(root, relativePath);
  // Ensure the resolved path is strictly within the root (not the root itself)
  if (!resolved.startsWith(root + path.sep)) {
    throw badRequest("Invalid path: outside workspace root");
  }
  return resolved;
}

/**
 * Express router for workspace file-system operations.
 *
 * All endpoints share the same authorization model: the caller must be
 * authenticated and must have access to the company that owns the workspace's
 * project (enforced by {@link assertCompanyAccess}).
 *
 * All client-supplied paths are relative to the workspace root and are
 * validated by {@link resolveSafePath} before any filesystem operation is
 * performed, preventing directory traversal outside the workspace.
 *
 * Mounted at `/api` by the main Express app, so routes become:
 * - `GET  /api/workspaces/:workspaceId/files`         – list directory
 * - `GET  /api/workspaces/:workspaceId/files/read`    – read file
 * - `POST /api/workspaces/:workspaceId/files/write`   – write file
 * - `POST /api/workspaces/:workspaceId/files/mkdir`   – create directory
 * - `DELETE /api/workspaces/:workspaceId/files`       – delete file/directory
 * - `POST /api/workspaces/:workspaceId/files/rename`  – rename/move
 *
 * @param db - Drizzle database instance injected at application startup.
 * @returns An Express {@link Router} with all workspace file routes registered.
 */
export function workspaceFilesRoutes(db: Db) {
  const router = Router();
  const projectSvc = projectService(db);

  /**
   * Loads a workspace by ID and asserts that the authenticated actor has
   * access to the company that owns its project.
   *
   * Returns `null` when the workspace or its parent project cannot be found,
   * in which case callers should respond with 404. Throws an authorization
   * error (which the error handler maps to 403) when access is denied.
   *
   * The returned workspace is guaranteed to have a non-null `cwd` field
   * suitable for filesystem operations. Workspaces without a local directory
   * are treated as "not found" for file operations.
   */
  async function getAuthorizedWorkspace(req: Parameters<typeof assertCompanyAccess>[0], workspaceId: string) {
    const workspace = await projectSvc.getWorkspaceByIdOnly(workspaceId);
    if (!workspace) return null;
    if (!workspace.cwd || workspace.cwd === REPO_ONLY_CWD_SENTINEL) return null;
    const project = await projectSvc.getById(workspace.projectId);
    if (!project) return null;
    assertCompanyAccess(req, project.companyId);
    return { ...workspace, cwd: workspace.cwd };
  }

  /**
   * GET /api/workspaces/:workspaceId/files?path=
   *
   * Lists the contents of a directory within the workspace.
   *
   * Query params:
   *   path  – relative path to list (defaults to "." i.e. workspace root)
   *
   * Response: { path: string, items: FileEntry[] }
   *   FileEntry: { name, type: "file"|"directory", size: number|null, modified: string|null }
   *
   * Errors: 400 (traversal or not-a-directory), 404 (workspace or path not found)
   */
  router.get("/workspaces/:workspaceId/files", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const relativePath = (req.query.path as string) ?? ".";
    // Use workspace root directly for "." to avoid triggering the root-guard
    const targetPath =
      relativePath === "." ? path.resolve(workspace.cwd) : resolveSafePath(workspace.cwd, relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      res.status(404).json({ error: "Path not found" });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const items = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(targetPath, entry.name);
        let size: number | null = null;
        let modified: string | null = null;
        try {
          const entryStat = await fs.stat(entryPath);
          size = entryStat.isFile() ? entryStat.size : null;
          modified = entryStat.mtime.toISOString();
        } catch {
          // ignore stat errors for individual entries (e.g. broken symlinks)
        }
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size,
          modified,
        };
      }),
    );

    res.json({ path: relativePath, items });
  });

  /**
   * GET /api/workspaces/:workspaceId/files/read?path=
   *
   * Reads a file's content and returns it as a UTF-8 string.
   * Not suitable for binary files (images, compiled assets, etc.).
   *
   * Query params:
   *   path  – relative path to the file (required)
   *
   * Response: { path: string, content: string }
   *
   * Errors: 400 (missing param, traversal, or not-a-file), 404 (workspace or file not found)
   */
  router.get("/workspaces/:workspaceId/files/read", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const relativePath = req.query.path as string | undefined;
    if (!relativePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const targetPath = resolveSafePath(workspace.cwd, relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: "Path is not a file" });
      return;
    }

    const content = await fs.readFile(targetPath, "utf-8");
    res.json({ path: relativePath, content });
  });

  /**
   * POST /api/workspaces/:workspaceId/files/write
   *
   * Creates or overwrites a file with the provided text content.
   * Intermediate parent directories are created automatically (`mkdir -p`).
   * Accepts an empty string for `content` to create or truncate a file.
   *
   * Body: { path: string, content: string }
   *
   * Response: { path: string, size: number, modified: string }
   *
   * Errors: 400 (missing fields or traversal), 404 (workspace not found)
   */
  router.post("/workspaces/:workspaceId/files/write", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const { path: relativePath, content } = req.body as { path?: string; content?: unknown };
    if (!relativePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }
    // Allow empty string — it is a valid file content (truncate/create empty file)
    if (content === undefined || content === null) {
      res.status(400).json({ error: "content is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }

    const targetPath = resolveSafePath(workspace.cwd, relativePath);

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf-8");

    const stat = await fs.stat(targetPath);
    res.json({
      path: relativePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  });

  /**
   * POST /api/workspaces/:workspaceId/files/mkdir
   *
   * Creates a directory (and any missing intermediate directories) within the
   * workspace. Idempotent: succeeds silently if the directory already exists.
   *
   * Body: { path: string }
   *
   * Response: { path: string }
   *
   * Errors: 400 (missing field or traversal), 404 (workspace not found)
   */
  router.post("/workspaces/:workspaceId/files/mkdir", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const { path: relativePath } = req.body as { path?: string };
    if (!relativePath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetPath = resolveSafePath(workspace.cwd, relativePath);

    // { recursive: true } makes this idempotent — no error if the dir exists
    await fs.mkdir(targetPath, { recursive: true });
    res.json({ path: relativePath });
  });

  /**
   * DELETE /api/workspaces/:workspaceId/files?path=
   *
   * Deletes a file or directory. Directory deletion is recursive — all
   * contents are permanently removed.
   *
   * Query params:
   *   path  – relative path to delete (required)
   *
   * Response: { path: string, deleted: true }
   *
   * Errors: 400 (missing param or traversal), 404 (workspace or path not found)
   */
  router.delete("/workspaces/:workspaceId/files", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const relativePath = req.query.path as string | undefined;
    if (!relativePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const targetPath = resolveSafePath(workspace.cwd, relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      res.status(404).json({ error: "Path not found" });
      return;
    }

    if (stat.isDirectory()) {
      // Recursively remove directory and all contents
      await fs.rm(targetPath, { recursive: true, force: true });
    } else {
      await fs.unlink(targetPath);
    }

    res.json({ path: relativePath, deleted: true });
  });

  /**
   * POST /api/workspaces/:workspaceId/files/rename
   *
   * Renames or moves a file or directory within the workspace. The destination's
   * parent directory is created automatically if it does not exist. If a file
   * already exists at `newPath` it will be overwritten (standard `fs.rename`
   * behaviour on POSIX systems).
   *
   * Body: { oldPath: string, newPath: string }
   *
   * Response: { oldPath: string, newPath: string }
   *
   * Errors: 400 (missing fields or traversal), 404 (workspace or source not found)
   */
  router.post("/workspaces/:workspaceId/files/rename", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const { oldPath: oldRelativePath, newPath: newRelativePath } = req.body as {
      oldPath?: string;
      newPath?: string;
    };
    if (!oldRelativePath) {
      res.status(400).json({ error: "oldPath is required" });
      return;
    }
    if (!newRelativePath) {
      res.status(400).json({ error: "newPath is required" });
      return;
    }

    const oldAbsPath = resolveSafePath(workspace.cwd, oldRelativePath);
    const newAbsPath = resolveSafePath(workspace.cwd, newRelativePath);

    // Verify the source exists before attempting the rename
    try {
      await fs.stat(oldAbsPath);
    } catch {
      res.status(404).json({ error: "Source path not found" });
      return;
    }

    // Ensure parent directory of destination exists
    await fs.mkdir(path.dirname(newAbsPath), { recursive: true });
    await fs.rename(oldAbsPath, newAbsPath);

    res.json({ oldPath: oldRelativePath, newPath: newRelativePath });
  });

  /**
   * GET /api/workspaces/:workspaceId/files/download?path=
   *
   * Downloads a single file with appropriate Content-Disposition header.
   */
  router.get("/workspaces/:workspaceId/files/download", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const relativePath = req.query.path as string | undefined;
    if (!relativePath) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const targetPath = resolveSafePath(workspace.cwd, relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: "Path is not a file" });
      return;
    }

    const fileName = path.basename(targetPath).replace(/[\x00-\x1f\x7f"\\]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Length", stat.size);
    createReadStream(targetPath).pipe(res);
  });

  /**
   * GET /api/workspaces/:workspaceId/files/download-zip?path=
   *
   * Downloads a directory as a ZIP archive.
   */
  router.get("/workspaces/:workspaceId/files/download-zip", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const relativePath = (req.query.path as string) ?? ".";
    const targetPath =
      relativePath === "." ? path.resolve(workspace.cwd) : resolveSafePath(workspace.cwd, relativePath);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      res.status(404).json({ error: "Path not found" });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ error: "Path is not a directory" });
      return;
    }

    const dirName = (relativePath === "." ? "workspace" : path.basename(targetPath)).replace(/[\x00-\x1f\x7f"\\]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${dirName}.zip"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("error", (err: Error) => {
      console.error("ZIP archive error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create archive" });
      } else {
        res.end();
      }
    });
    archive.pipe(res);
    archive.directory(targetPath, dirName);
    archive.finalize();
  });

  /**
   * GET /api/workspaces/:workspaceId/files/git-info
   *
   * Returns basic git information for the workspace directory:
   * current branch name and whether the working tree is clean.
   *
   * Response: { branch: string | null, dirty: boolean }
   *
   * If the workspace is not a git repository, `branch` is null.
   */
  router.get("/workspaces/:workspaceId/files/git-info", async (req, res) => {
    const workspaceId = req.params.workspaceId as string;
    const workspace = await getAuthorizedWorkspace(req, workspaceId);
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    const cwd = workspace.cwd;
    try {
      const { stdout: branch } = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd, timeout: 5000 },
      );
      const { stdout: status } = await execFileAsync(
        "git",
        ["status", "--porcelain"],
        { cwd, timeout: 5000 },
      );
      res.json({
        branch: branch.trim(),
        dirty: status.trim().length > 0,
      });
    } catch {
      // Not a git repo or git not available
      res.json({ branch: null, dirty: false });
    }
  });

  return router;
}
