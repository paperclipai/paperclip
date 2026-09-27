import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { formatDatabaseBackupResult, runDatabaseBackup } from "./backup-lib.js";
import { DEFAULT_BACKUP_RETENTION, formatBackupRetentionPolicy } from "@paperclipai/shared";
import {
  expandHomePrefix,
  resolveDefaultBackupDir,
  resolvePaperclipConfigPathForInstance,
} from "@paperclipai/shared/home-paths";

type PartialConfig = {
  database?: {
    mode?: "embedded-postgres" | "postgres";
    connectionString?: string;
    embeddedPostgresPort?: number;
    backup?: {
      dir?: string;
    };
  };
};

function readConfig(configPath: string): PartialConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return typeof parsed === "object" && parsed ? (parsed as PartialConfig) : null;
  } catch {
    return null;
  }
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

function resolveEmbeddedPort(config: PartialConfig | null): number {
  return asPositiveInt(config?.database?.embeddedPostgresPort) ?? 54329;
}

function resolveConnectionString(config: PartialConfig | null): string {
  const envUrl = process.env.DATABASE_URL?.trim();
  if (envUrl) return envUrl;

  if (config?.database?.mode === "postgres" && typeof config.database.connectionString === "string") {
    const trimmed = config.database.connectionString.trim();
    if (trimmed) return trimmed;
  }

  const port = resolveEmbeddedPort(config);
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function resolveBackupDir(config: PartialConfig | null): string {
  const raw = config?.database?.backup?.dir;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.resolve(expandHomePrefix(raw.trim()));
  }
  return resolveDefaultBackupDir();
}

async function main() {
  const configPath = resolvePaperclipConfigPathForInstance();
  const config = readConfig(configPath);
  const connectionString = resolveConnectionString(config);
  const backupDir = resolveBackupDir(config);

  console.log(`Config path: ${configPath}`);
  console.log(`Backing up database to: ${backupDir}`);
  const retention = DEFAULT_BACKUP_RETENTION;
  console.log(`Retention policy: ${formatBackupRetentionPolicy(retention)}`);

  try {
    const result = await runDatabaseBackup({
      connectionString,
      backupDir,
      retention,
      filenamePrefix: "paperclip",
    });

    console.log(`Backup saved: ${formatDatabaseBackupResult(result)}`);
  } catch (err) {
    console.error("Backup failed.");
    if (err instanceof Error) {
      console.error(err.message);
    } else {
      console.error(String(err));
    }
    process.exit(1);
  }
}

await main();
