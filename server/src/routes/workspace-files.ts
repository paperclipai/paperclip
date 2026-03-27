import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

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
    const realCwd = await fs.realpath(cwd);
    const resolved = path.resolve(cwd, relativePath);
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
        // Path doesn't exist — check that the logical path is within cwd
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
    const realCwd = await fs.realpath(cwd);
    const resolved = path.resolve(cwd, relativePath);
    // Logical check first
    if (
      resolved !== realCwd &&
      !resolved.startsWith(realCwd + path.sep)
    ) {
      return null;
    }
    // Check parent directory — it may already exist and be a symlink
    const parentDir = path.dirname(resolved);
    try {
      const realParent = await fs.realpath(parentDir);
      if (
        realParent !== realCwd &&
        !realParent.startsWith(realCwd + path.sep)
      ) {
        return null;
      }
    } catch {
      // Parent doesn't exist yet — will be created by mkdir; logical check passed
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

    try {
      const stat = await fs.stat(absolutePath);
      if (stat.isDirectory()) {
        res.status(422).json({ error: "Path is a directory, not a file" });
        return;
      }
      if (stat.size > MAX_FILE_BYTES) {
        res.status(413).json({ error: "File exceeds 10 MB read limit" });
        return;
      }
      const content = await fs.readFile(absolutePath, "utf8");
      res.json({ content, path: filePath, size: stat.size });
    } catch (err: unknown) {
      const code = errCode(err);
      if (code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
      } else if (code === "EACCES") {
        res.status(403).json({ error: "Permission denied" });
      } else {
        res.status(500).json({ error: "Failed to read file" });
      }
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
        const files = entries
          .filter((e) => showHidden || !e.name.startsWith("."))
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

        res.json({ files });
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

  return router;
}
