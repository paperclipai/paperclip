import { Router } from "express";
import type { BackupRetentionPolicy, Db, RunDatabaseBackupResult } from "@paperclipai/db";
import { assertInstanceAdmin } from "./authz.js";
import { logInstanceActivity, instanceActorFromRequest } from "../services/instance-activity-log.js";

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

export function instanceDatabaseBackupRoutes(service: InstanceDatabaseBackupService, db: Db) {
  const router = Router();

  router.post("/instance/database-backups", async (req, res) => {
    assertInstanceAdmin(req);
    const result = await service.runManualBackup();
    await logInstanceActivity(db, {
      ...instanceActorFromRequest(req),
      action: "instance.database_backup_triggered",
      entityType: "instance_database_backup",
      entityId: result.trigger,
      details: {
        trigger: result.trigger,
        startedAt: result.startedAt,
        durationMs: result.durationMs,
      },
    });
    res.status(201).json(result);
  });

  return router;
}
