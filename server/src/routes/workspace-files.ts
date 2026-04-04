import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DIR_ENTRIES = 1000;

export function workspaceFileRoutes(db: Db) {
  const router = Router();

  /**
   * Resolve a relative path safely within a workspace CWD.
   * Uses realpath to follow symlinks before checking containment,
   * preventing symlink-based traversal attacks.
   */
  async function resolveWithinWorkspace(
    cwd: string,
    relativePath: string,
  ): Promise<string | null> {
    let realCwd: string;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      return null;
    }
    const resolved = path.resolve(realCwd, relativePath);
    try {
      const realResolved = await fs.realpath(resolved);
      if (
        realResolved !== realCwd &&
        !realResolved.startsWith(realCwd + path.sep)
      ) {
        return null;
      }
      return realResolved;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          resolved !== realCwd &&
          !resolved.startsWith(realCwd + path.sep)
        ) {
          return null;
        }
        return resolved;
      }
      return null;
    }
  }

  /**
   * For write operations: verify the parent directory resolves within the
   * workspace, even after following symlinks.
   */
  async function resolveWithinWorkspaceForWrite(
    cwd: string,
    relativePath: string,
  ): Promise<string | null> {
    let realCwd: string;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      return null;
    }
    const resolved = path.resolve(realCwd, relativePath);
    if (
      resolved !== realCwd &&
      !resolved.startsWith(realCwd + path.sep)
    ) {
      return null;
    }
    // Walk up from the target to find the closest existing ancestor and verify
    // it resolves within the workspace. This prevents mkdir from following a
    // symlink ancestor that points outside the workspace boundary.
    let checkDir = path.dirname(resolved);
    while (checkDir !== realCwd && checkDir.startsWith(realCwd + path.sep)) {
      try {
        const realAncestor = await fs.realpath(checkDir);
        if (
          realAncestor !== realCwd &&
          !realAncestor.startsWith(realCwd + path.sep)
        ) {
          return null;
        }
        break;
      } catch {
        checkDir = path.dirname(checkDir);
      }
    }
    return resolved;
  }

  function errCode(err: unknown): string | undefined {
    return (err as NodeJS.ErrnoException).code;
  }

  async function lookupWorkspace(
    companyId: string,
    workspaceId: string,
  ) {
    const rows = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.id, workspaceId),
          eq(projectWorkspaces.companyId, companyId),
        ),
      );
    return rows[0] ?? null;
  }

  // ── Read a file ───────────────────────────────────────────────────────────

  router.get("/companies/:companyId/workspace-files", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const workspaceId = req.query.workspaceId as string | undefined;
    const filePath = req.query.path as string | undefined;

    if (!workspaceId || !filePath) {
      res.status(422).json({ error: "workspaceId and path are required" });
      return;
    }

    const workspace = await lookupWorkspace(companyId, workspaceId);
    if (!workspace || !workspace.cwd) {
      res
        .status(404)
        .json({ error: "Workspace not found or has no local directory" });
      return;
    }

    const absolutePath = await resolveWithinWorkspace(workspace.cwd, filePath);
    if (!absolutePath) {
      res.status(403).json({ error: "Path is outside workspace directory" });
      return;
    }

    let fh: import("node:fs/promises").FileHandle | null = null;
    try {
      fh = await fs.open(absolutePath, "r");
      const stat = await fh.stat();
      if (stat.isDirectory()) {
        res.status(422).json({ error: "Path is a directory, not a file" });
        return;
      }
      if (stat.size > MAX_FILE_BYTES) {
        res.status(413).json({ error: "File exceeds 10 MB read limit" });
        return;
      }
      const content = await fh.readFile("utf8");
      res.json({ content, path: filePath, size: stat.size });
    } catch (err: unknown) {
      const code = errCode(err);
      if (code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
      } else if (code === "EACCES") {
        res.status(403).json({ error: "Permission denied" });
      } else if (code === "EISDIR") {
        res.status(422).json({ error: "Path is a directory, not a file" });
      } else {
        res.status(500).json({ error: "Failed to read file" });
      }
    } finally {
      await fh?.close();
    }
  });

  // ── Write a file ──────────────────────────────────────────────────────────

  router.put("/companies/:companyId/workspace-files", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const workspaceId = req.query.workspaceId as string | undefined;
    const filePath = req.query.path as string | undefined;
    const content = req.body?.content;

    if (!workspaceId || !filePath) {
      res.status(422).json({ error: "workspaceId and path are required" });
      return;
    }

    if (typeof content !== "string") {
      res.status(422).json({ error: "content (string) is required in body" });
      return;
    }

    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      res.status(413).json({ error: "File content exceeds 10 MB limit" });
      return;
    }

    const workspace = await lookupWorkspace(companyId, workspaceId);
    if (!workspace || !workspace.cwd) {
      res
        .status(404)
        .json({ error: "Workspace not found or has no local directory" });
      return;
    }

    const absolutePath = await resolveWithinWorkspaceForWrite(workspace.cwd, filePath);
    if (!absolutePath) {
      res.status(403).json({ error: "Path is outside workspace directory" });
      return;
    }

    try {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
      res.json({ ok: true });
    } catch (err: unknown) {
      const code = errCode(err);
      if (code === "EACCES") {
        res.status(403).json({ error: "Permission denied" });
      } else {
        res.status(500).json({ error: "Failed to write file" });
      }
    }
  });

  // ── List files in a directory ─────────────────────────────────────────────

  router.get(
    "/companies/:companyId/workspace-files/list",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const workspaceId = req.query.workspaceId as string | undefined;
      const dirPath = (req.query.path as string | undefined) ?? ".";

      if (!workspaceId) {
        res.status(422).json({ error: "workspaceId is required" });
        return;
      }

      const workspace = await lookupWorkspace(companyId, workspaceId);
      if (!workspace || !workspace.cwd) {
        res
          .status(404)
          .json({ error: "Workspace not found or has no local directory" });
        return;
      }

      const absoluteDir = await resolveWithinWorkspace(workspace.cwd, dirPath);
      if (!absoluteDir) {
        res.status(403).json({ error: "Path is outside workspace directory" });
        return;
      }

      try {
        const showHidden = String(req.query.showHidden).toLowerCase() === "true";
        const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
        const filtered = entries.filter((e) => showHidden || !e.name.startsWith("."));
        const truncated = filtered.length > MAX_DIR_ENTRIES;
        const files = filtered
          .slice(0, MAX_DIR_ENTRIES)
          .map((e) => ({
            name: e.name,
            path: path.posix.join(
              dirPath === "." ? "" : dirPath,
              e.name,
            ),
            isDirectory: e.isDirectory(),
          }))
          .sort((a, b) => {
            // Directories first, then alphabetical
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
          });

        res.json({ files, truncated });
      } catch (err: unknown) {
        const code = errCode(err);
        if (code === "ENOENT") {
          res.status(404).json({ error: "Directory not found" });
        } else if (code === "ENOTDIR") {
          res.status(422).json({ error: "Path is a file, not a directory" });
        } else if (code === "EACCES") {
          res.status(403).json({ error: "Permission denied" });
        } else {
          res.status(500).json({ error: "Failed to list directory" });
        }
      }
    },
  );

  // ── Move or copy a file ────────────────────────────────────────────────────

  router.post(
    "/companies/:companyId/workspace-files/move",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { workspaceId, from, to, copy } = req.body ?? {};

      if (!workspaceId || !from || !to) {
        res.status(422).json({ error: "workspaceId, from, and to are required" });
        return;
      }
      if (typeof from !== "string" || typeof to !== "string") {
        res.status(422).json({ error: "from and to must be strings" });
        return;
      }

      const workspace = await lookupWorkspace(companyId, workspaceId);
      if (!workspace || !workspace.cwd) {
        res.status(404).json({ error: "Workspace not found or has no local directory" });
        return;
      }

      const absSrc = await resolveWithinWorkspace(workspace.cwd, from);
      if (!absSrc) {
        res.status(403).json({ error: "Source path is outside workspace directory" });
        return;
      }

      const absDest = await resolveWithinWorkspaceForWrite(workspace.cwd, to);
      if (!absDest) {
        res.status(403).json({ error: "Destination path is outside workspace directory" });
        return;
      }

      // Reject if destination already exists (no silent overwrite)
      try {
        await fs.access(absDest);
        res.status(409).json({ error: "Destination already exists" });
        return;
      } catch {
        // ENOENT is expected — destination doesn't exist yet
      }

      try {
        await fs.mkdir(path.dirname(absDest), { recursive: true });
        if (copy) {
          await fs.cp(absSrc, absDest, { recursive: true });
        } else {
          try {
            await fs.rename(absSrc, absDest);
          } catch (err: unknown) {
            if (errCode(err) === "EXDEV") {
              await fs.cp(absSrc, absDest, { recursive: true });
              await fs.rm(absSrc, { recursive: true });
            } else {
              throw err;
            }
          }
        }
        res.json({ ok: true });
      } catch (err: unknown) {
        const code = errCode(err);
        if (code === "ENOENT") {
          res.status(404).json({ error: "Source file not found" });
        } else if (code === "EACCES") {
          res.status(403).json({ error: "Permission denied" });
        } else {
          res.status(500).json({ error: `Failed to ${copy ? "copy" : "move"} file` });
        }
      }
    },
  );

  // ── Delete a file or directory ────────────────────────────────────────────

  router.delete(
    "/companies/:companyId/workspace-files",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const workspaceId = req.query.workspaceId as string | undefined;
      const filePath = req.query.path as string | undefined;
      const recursive = String(req.query.recursive).toLowerCase() === "true";

      if (!workspaceId || !filePath) {
        res.status(422).json({ error: "workspaceId and path are required" });
        return;
      }

      const workspace = await lookupWorkspace(companyId, workspaceId);
      if (!workspace || !workspace.cwd) {
        res.status(404).json({ error: "Workspace not found or has no local directory" });
        return;
      }

      const absolutePath = await resolveWithinWorkspace(workspace.cwd, filePath);
      if (!absolutePath) {
        res.status(403).json({ error: "Path is outside workspace directory" });
        return;
      }

      let realCwd: string;
      try {
        realCwd = await fs.realpath(workspace.cwd);
      } catch {
        res.status(404).json({ error: "Workspace directory not found" });
        return;
      }
      if (absolutePath === realCwd) {
        res.status(403).json({ error: "Cannot delete the workspace root" });
        return;
      }

      // Require explicit recursive flag for directories
      try {
        const stat = await fs.stat(absolutePath);
        if (stat.isDirectory() && !recursive) {
          res.status(422).json({ error: "Path is a directory — pass recursive=true to delete" });
          return;
        }
      } catch (err: unknown) {
        if (errCode(err) === "ENOENT") {
          res.status(404).json({ error: "File not found" });
          return;
        }
      }

      try {
        await fs.rm(absolutePath, { recursive });
        res.json({ ok: true });
      } catch (err: unknown) {
        const code = errCode(err);
        if (code === "ENOENT") {
          res.status(404).json({ error: "File not found" });
        } else if (code === "EACCES") {
          res.status(403).json({ error: "Permission denied" });
        } else {
          res.status(500).json({ error: "Failed to delete" });
        }
      }
    },
  );

  return router;
}
