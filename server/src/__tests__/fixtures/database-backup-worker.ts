import { createDatabaseBackupOwner } from "../../services/database-backup-owner.js";
const run = createDatabaseBackupOwner({
  connectionString: process.env.PAPERCLIP_BACKUP_WORKER_DATABASE_URL!, backupDir: process.env.PAPERCLIP_BACKUP_WORKER_DIRECTORY!,
  getRetention: async () => ({ dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 }),
  logger: { info() {}, warn() {}, error() {} },
});
await run("idle");
throw new Error("Interrupted backup fixture unexpectedly completed");
