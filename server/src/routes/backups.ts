import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import {
  archiveBackupSchema,
  deleteBackupSchema,
  restoreBackupSchema,
  unarchiveBackupSchema,
  updateBackupSettingsSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { validate } from "../middleware/validate.js";
import type { BackupManager } from "../services/backups.js";
import { assertBoard } from "./authz.js";

const MAX_BACKUP_IMPORT_BYTES = Number(process.env.PAPERCLIP_BACKUP_IMPORT_MAX_BYTES) || 2 * 1024 * 1024 * 1024;

function assertInstanceAdmin(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  throw forbidden("Instance admin required");
}

export function backupRoutes(backupManager: BackupManager) {
  const router = Router();
  const uploadDir = path.resolve(resolvePaperclipInstanceRoot(), "tmp", "backup-import-uploads");
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: MAX_BACKUP_IMPORT_BYTES, files: 1 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.get("/backups", async (req, res) => {
    assertInstanceAdmin(req);
    res.json(await backupManager.getOverview());
  });

  router.post("/backups/run", async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const run = await backupManager.createManualBackup(actorId);
    res.status(202).json(run);
  });

  router.patch("/backups/settings", validate(updateBackupSettingsSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const settings = await backupManager.updateSettings(req.body, actorId);
    res.json(settings);
  });

  router.post("/backups/import", async (req, res) => {
    assertInstanceAdmin(req);

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Backup archive exceeds ${MAX_BACKUP_IMPORT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file?.path) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    if (file.size <= 0) {
      await rm(file.path, { force: true });
      res.status(422).json({ error: "Backup archive is empty" });
      return;
    }

    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    try {
      const imported = await backupManager.importBackupArchive(file.path, file.originalname || null, actorId);
      res.status(201).json(imported);
    } finally {
      await rm(file.path, { force: true });
    }
  });

  router.get("/backups/:backupId/download", async (req, res, next) => {
    assertInstanceAdmin(req);

    try {
      const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
      const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
      const download = await backupManager.getDownloadDescriptor(backupId, actorId);
      const tar = spawn("tar", ["-czf", "-", "-C", download.bundleDirectory, download.bundleName], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      const onRequestClose = () => {
        tar.kill("SIGTERM");
      };

      req.on("close", onRequestClose);
      tar.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      tar.on("error", (error) => {
        req.off("close", onRequestClose);
        next(error);
      });
      tar.on("close", (code) => {
        req.off("close", onRequestClose);
        if (code === 0) return;
        const error = new Error(stderr.trim() || `tar exited with code ${code}`);
        if (res.headersSent) {
          res.destroy(error);
          return;
        }
        next(error);
      });

      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${download.archiveName}"`);
      tar.stdout.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  router.get("/backups/:backupId/preview-restore", async (req, res) => {
    assertInstanceAdmin(req);
    const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
    res.json(await backupManager.previewRestore(backupId));
  });

  router.post("/backups/:backupId/restore", validate(restoreBackupSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
    const state = await backupManager.restoreBackup(backupId, actorId);
    res.status(202).json(state);
  });

  router.post("/backups/:backupId/archive", validate(archiveBackupSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
    res.json(await backupManager.archiveBackup(backupId, actorId));
  });

  router.post("/backups/:backupId/unarchive", validate(unarchiveBackupSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
    res.json(await backupManager.unarchiveBackup(backupId, actorId));
  });

  router.post("/backups/:backupId/delete", validate(deleteBackupSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actorId = req.actor.userId ?? (req.actor.source === "local_implicit" ? "local-board" : null);
    const backupId = Array.isArray(req.params.backupId) ? req.params.backupId[0] : req.params.backupId;
    res.json(await backupManager.deleteBackup(backupId, actorId));
  });

  return router;
}
