import { Router } from "express";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface FsBrowseResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

export function fsRoutes() {
  const router = Router();

  /**
   * GET /fs/browse
   * Browse the server filesystem.
   * Query params:
   *   path        — absolute path to browse (defaults to home directory)
   *   showHidden  — "true" to include hidden files/folders (default: false)
   */
  router.get("/browse", (req, res) => {
    const showHidden = req.query.showHidden === "true";
    let rawPath = typeof req.query.path === "string" ? req.query.path : "~";

    // Expand ~ to home directory
    if (rawPath === "~" || rawPath.startsWith("~/")) {
      rawPath = rawPath.replace(/^~/, os.homedir());
    }

    // Resolve and normalise
    const dir = path.resolve(rawPath);

    // Must be an absolute path
    if (!path.isAbsolute(dir)) {
      res.status(400).json({ error: "path must be absolute" });
      return;
    }

    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(dir);
    } catch {
      res.status(404).json({ error: "path not found" });
      return;
    }

    if (!stat.isDirectory()) {
      res.status(400).json({ error: "path is not a directory" });
      return;
    }

    let names: string[];
    try {
      names = fsSync.readdirSync(dir);
    } catch {
      res.status(403).json({ error: "cannot read directory" });
      return;
    }

    const entries: FsEntry[] = [];
    for (const name of names) {
      if (!showHidden && name.startsWith(".")) continue;
      const fullPath = path.join(dir, name);
      let isDirectory = false;
      try {
        isDirectory = fsSync.statSync(fullPath).isDirectory();
      } catch {
        // skip entries we can't stat (broken symlinks, permission errors)
        continue;
      }
      entries.push({ name, path: fullPath, isDirectory });
    }

    // Directories first, then files — both sorted alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = dir !== path.parse(dir).root ? path.dirname(dir) : null;

    const result: FsBrowseResult = { path: dir, parent, entries };
    res.json(result);
  });

  return router;
}
