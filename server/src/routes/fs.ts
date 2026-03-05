import { Router } from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertBoard } from "./authz.js";
import { badRequest, notFound } from "../errors.js";

export function fsRoutes() {
  const router = Router();

  router.get("/fs/browse", async (req, res, next) => {
    try {
      assertBoard(req);

      const rawPath = typeof req.query.path === "string" ? req.query.path.trim() : "";
      const targetPath = rawPath || os.homedir();

      if (rawPath && !path.isAbsolute(rawPath)) {
        throw badRequest("path must be absolute");
      }

      const resolved = path.resolve(targetPath);
      const parentDir = path.dirname(resolved);
      const parent = parentDir !== resolved ? parentDir : null;

      let dirents: import("node:fs").Dirent[];
      try {
        dirents = await fs.readdir(resolved, { withFileTypes: true });
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") throw notFound(`Directory not found: ${resolved}`);
        if (code === "ENOTDIR") throw badRequest(`Path is not a directory: ${resolved}`);
        throw err;
      }

      const showHidden = req.query.showHidden === "true";
      const entries = dirents
        .filter((d) => d.isDirectory() && (showHidden || !d.name.startsWith(".")))
        .map((d) => ({ name: d.name, path: path.join(resolved, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({ path: resolved, parent, entries });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
