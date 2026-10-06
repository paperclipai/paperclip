import fs from "node:fs";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { formatDatabaseBackupResult, runDatabaseBackup } from "@paperclipai/db";
import {
  formatBackupRetentionPolicy,
  type DatabaseBackupRetentionPolicy,
} from "@paperclipai/shared";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipInstanceId,
} from "../config/home.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printPaperclipCliBanner } from "../utils/banner.js";

type DbBackupOptions = {
  config?: string;
  dir?: string;
  filenamePrefix?: string;
  json?: boolean;
};

function resolveConnectionString(configPath?: string): { value: string; source: string } {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return { value: envUrl, source: "DATABASE_URL" };

  const config = readConfig(configPath);
  if (config?.database.mode === "postgres" && config.database.connectionString?.trim()) {
    return { value: config.database.connectionString.trim(), source: "config.database.connectionString" };
  }

  const port = config?.database.embeddedPostgresPort ?? 54329;
  return {
    value: `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`,
    source: `embedded-postgres@${port}`,
  };
}

function resolveBackupDir(raw: string): string {
  return path.resolve(expandHomePrefix(raw.trim()));
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

// One-off backups share the scheduled backup directory and filename prefix,
// so pruning with the narrower scheduled default could delete restore points
// the configured policy would keep. Use the widest presets as the safe base.
// A retired retentionDays scalar only widens the window further, never narrows it.
// readConfig() already migrated (deleted) retentionDays, so read the raw file.
function readRawLegacyDays(configPath: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      database?: { backup?: { retentionDays?: unknown } };
    } | null;
    return asPositiveInt(raw?.database?.backup?.retentionDays);
  } catch {
    return null;
  }
}

function resolveRetention(configPath?: string): DatabaseBackupRetentionPolicy {
  const fromConfig = configPath ? readRawLegacyDays(configPath) : null;
  const envRaw = process.env.PAPERCLIP_DB_BACKUP_RETENTION_DAYS?.trim();
  const fromEnv = envRaw ? asPositiveInt(Number(envRaw)) : null;
  // Environment override wins over the file value (former precedence).
  const legacyDays = fromEnv ?? fromConfig;
  if (legacyDays == null) {
    return { hourlyHours: 48, dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 };
  }
  return {
    hourlyHours: 48,
    dailyDays: 14,
    weeklyWeeks: 4,
    monthlyMonths: Math.max(6, Math.ceil(legacyDays / 30)),
  };
}

export async function dbBackupCommand(opts: DbBackupOptions): Promise<void> {
  printPaperclipCliBanner();
  p.intro(pc.bgCyan(pc.black(" paperclip db:backup ")));

  const configPath = resolveConfigPath(opts.config);
  const config = readConfig(opts.config);
  const connection = resolveConnectionString(opts.config);
  const defaultDir = resolveDefaultBackupDir(resolvePaperclipInstanceId());
  const configuredDir = opts.dir?.trim() || config?.database.backup.dir || defaultDir;
  const backupDir = resolveBackupDir(configuredDir);
  const filenamePrefix = opts.filenamePrefix?.trim() || "paperclip";

  p.log.message(pc.dim(`Config: ${configPath}`));
  p.log.message(pc.dim(`Connection source: ${connection.source}`));
  const retention = resolveRetention(configPath);
  p.log.message(pc.dim(`Backup dir: ${backupDir}`));
  p.log.message(pc.dim(`Retention: ${formatBackupRetentionPolicy(retention)}`));

  const spinner = p.spinner();
  spinner.start("Creating database backup...");
  try {
    const result = await runDatabaseBackup({
      connectionString: connection.value,
      backupDir,
      retention,
      filenamePrefix,
    });
    spinner.stop(`Backup saved: ${formatDatabaseBackupResult(result)}`);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir,
            retention,
            connectionSource: connection.source,
          },
          null,
          2,
        ),
      );
    }
    p.outro(pc.green("Backup completed."));
  } catch (err) {
    spinner.stop(pc.red("Backup failed."));
    throw err;
  }
}
