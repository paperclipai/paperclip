import { Router } from "express";
import type { BackupRetentionPolicy, RunDatabaseBackupResult } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { isCloudManagedInstance } from "../middleware/auth.js";
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

  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    // Floor: on cloud-managed instances database backups are platform-owned.
    // The manual trigger stays off for every actor, including computed
    // owner-admins — the result would also echo the server-side backup
    // directory path, which managed tenants must not see.
    if (isCloudManagedInstance()) {
      throw forbidden("Database backups are platform-managed on cloud-managed instances", {
        code: "database_backups_platform_managed",
      });
    }
    const result = await service.runManualBackup();
    res.status(201).json(result);
  });

  return router;
}
