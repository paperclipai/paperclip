import { Router } from "express";
import type { BackupRetentionPolicy, RunDatabaseBackupResult } from "@paperclipai/db";
import { assertInstanceAdmin } from "./authz.js";

export type InstanceDatabaseBackupTrigger = "manual" | "scheduled";

export type InstanceDatabaseBackupRunResult = RunDatabaseBackupResult & {
  trigger: InstanceDatabaseBackupTrigger;
  backupDir: string;
  retention: BackupRetentionPolicy;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
};

export type InstanceDatabaseBackupService = {
  runManualBackup(): Promise<InstanceDatabaseBackupRunResult>;
};

export function instanceDatabaseBackupRoutes(service: InstanceDatabaseBackupService) {
  const router = Router();

  /**
   * Admin-only internal endpoint — intended for privileged clients (admin tools,
   * the server's own scheduled backup process), not the regular UI or CLI.
   * Board-user auth is enforced via `assertInstanceAdmin` middleware.
   */
  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await service.runManualBackup();
    res.status(201).json(result);
  });

  return router;
}
