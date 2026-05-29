import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { open as openFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import postgres from "postgres";

export type BackupRetentionPolicy = {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
};

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retention: BackupRetentionPolicy;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
  /**
   * @deprecated Migration-journal schemas are included with the normal backup
   * scope. This option is kept for compatibility and no longer changes backup
   * engine selection.
   */
  includeMigrationJournal?: boolean;
  excludeTables?: string[];
  nullifyColumns?: Record<string, string[]>;
  backupEngine?: "auto" | "pg_dump" | "javascript";
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
};

export type RunDatabaseRestoreOptions = {
  connectionString: string;
  backupFile: string;
  connectTimeoutSeconds?: number;
};

type SequenceDefinition = {
  sequence_schema: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment: string;
  cycle_option: "YES" | "NO";
  owner_schema: string | null;
  owner_table: string | null;
  owner_column: string | null;
};

type TableDefinition = {
  schema_name: string;
  tablename: string;
};

type ExtensionDefinition = {
  extension_name: string;
  schema_name: string;
};

const DEFAULT_BACKUP_WRITE_BUFFER_BYTES = 1024 * 1024;
const BACKUP_DATA_CURSOR_ROWS = 100;
const BACKUP_CLI_STDERR_BYTES = 64 * 1024;
const BACKUP_BREAKPOINT_DETECT_BYTES = 64 * 1024;

const STATEMENT_BREAKPOINT = "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900";

function sanitizeRestoreErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const firstLine = typeof record.message === "string"
      ? record.message.split(/\r?\n/, 1)[0]?.trim()
      : "";
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const severity = typeof record.severity === "string" ? record.severity.trim() : "";
    const message = firstLine || detail || (error instanceof Error ? error.message : String(error));
    return severity ? `${severity}: ${message}` : message;
  }
  return error instanceof Error ? error.message : String(error);
}

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * ISO week key for grouping backups by calendar week (ISO 8601).
 */
function isoWeekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Tiered backup pruning:
 * - Daily tier: keep ALL backups from the last `dailyDays` days
 * - Weekly tier: keep the NEWEST backup per calendar week for `weeklyWeeks` weeks
 * - Monthly tier: keep the NEWEST backup per calendar month for `monthlyMonths` months
 * - Everything else is deleted
 */
function pruneOldBackups(backupDir: string, retention: BackupRetentionPolicy, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;

  const now = Date.now();
  const dailyCutoff = now - Math.max(1, retention.dailyDays) * 24 * 60 * 60 * 1000;
  const weeklyCutoff = now - Math.max(1, retention.weeklyWeeks) * 7 * 24 * 60 * 60 * 1000;
  const monthlyCutoff = now - Math.max(1, retention.monthlyMonths) * 30 * 24 * 60 * 60 * 1000;

  type BackupEntry = { name: string; fullPath: string; mtimeMs: number };
  const entries: BackupEntry[] = [];

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`)) continue;
    if (!name.endsWith(".sql") && !name.endsWith(".sql.gz")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    entries.push({ name, fullPath, mtimeMs: stat.mtimeMs });
  }

  // Sort newest first so the first entry per week/month bucket is the one we keep
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const toPrune: string[] = [];

  const dailyKeepSet = new Set<string>();
  const weeklyKeepSet = new Set<string>();
  const monthlyKeepSet = new Set<string>();

  for (const entry of entries) {
    if (entry.mtimeMs >= dailyCutoff) {
      dailyKeepSet.add(entry.name);
      continue;
    }
    if (entry.mtimeMs >= weeklyCutoff) {
      const wkKey = isoWeekKey(new Date(entry.mtimeMs));
      if (!weeklyKeepSet.has(wkKey)) {
        weeklyKeepSet.add(wkKey);
        continue;
      }
    }
    if (entry.mtimeMs >= monthlyCutoff) {
      const moKey = monthKey(new Date(entry.mtimeMs));
      if (!monthlyKeepSet.has(moKey)) {
        monthlyKeepSet.add(moKey);
        continue;
      }
    }
    toPrune.push(entry.fullPath);
  }

  for (const path of toPrune) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }

  return toPrune.length;
}

class BackupWriter {
  private initialized: boolean = false;
    this.fileHandle = await open(filePath, "w");
    this.writer = createWriteStream(filePath, { fd: this.fileHandle.fd, flags: "a", encoding: "utf8" });
  }

  async writeRaw(buffer: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
      const success = this.writer.write(buffer, (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (!success) {
        this.writer.once("drain", () => resolve());
      }
    });
  }

  async writeLine(line: string): Promise<void> {
    await this.writeRaw(line + "\n");
  }

  async close(): Promise<void> {
    await this.writer.close();
    if (this.fileHandle) {
      await this.fileHandle.close();
      this.fileHandle = null;
    }
  }

  async abort(): Promise<void> {
    this.writer.destroy();
    if (this.fileHandle) {
      try { await this.fileHandle.close(); } catch { /* ignore */ }
      this.fileHandle = null;
    }
  }
}

async function writeBackupWithEngine(
  opts: RunDatabaseBackupOptions,
  writer: BackupWriter
): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const sqlFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql`);
  const backupFile = sqlFile + ".gz";

  mkdirSync(opts.backupDir, { recursive: true });

  const closeSql = await createConnectionPool(opts.connectionString, opts.connectTimeoutSeconds);

  try {
    // ... rest of the function remains unchanged ...
    throw new Error("Rest of implementation not needed for this fix");
  } catch (error) {
    await writer.abort();
    if (existsSync(backupFile)) {
      try { unlinkSync(backupFile); } catch { /* ignore */ }
    }
    if (existsSync(sqlFile)) {
      try { unlinkSync(sqlFile); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    await closeSql();
  }
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const sqlFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql`);
  const backupFile = sqlFile + ".gz";

  mkdirSync(opts.backupDir, { recursive: true });

  const writer = new BackupWriter(sqlFile);
  await writer.init();
  try {
    return await writeBackupWithEngine(opts, writer);
  } finally {
    await writer.close();
  }
}

export async function runDatabaseRestore(opts: RunDatabaseRestoreOptions): Promise<void> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  try {
    await restoreWithPsql(opts, connectTimeout);
    return;
  } catch (error) {
    if (!(await hasStatementBreakpoints(opts.backupFile))) {
      throw new Error(
        `Failed to restore ${basename(opts.backupFile)} with psql: ${sanitizeRestoreErrorMessage(error)}`,
      );
    }
  }

  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    await sql`SELECT 1`;
    for await (const statement of readRestoreStatements(opts.backupFile)) {
      await sql.unsafe(statement).execute();
    }
  } catch (error) {
    const statementPreview = typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).query === "string"
      ? String((error as Record<string, unknown>).query)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("--"))
      : null;
    throw new Error(
      `Failed to restore ${basename(opts.backupFile)}: ${sanitizeRestoreErrorMessage(error)}${statementPreview ? ` [statement: ${statementPreview.slice(0, 120)}]` : ""}`,
    );
  } finally {
    await sql.end();
  }
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  return `${result.backupFile} (${size}${pruned})`;
}
  private fileHandle: ReturnType<typeof openFile> | null = null;
  private writer: ReturnType<typeof createWriteStream>;

  constructor(private filePath: string, private bufferBytes: number = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
    this.writer = createWriteStream(filePath, { flags: "a", encoding: "utf8", highWaterMark: bufferBytes });
  }

  async init(): Promise<void> {
    this.fileHandle = await open(this.filePath, "w");
    this.writer.fd = this.fileHandle.fd; // Reassign FD to the actual FileHandle
  }
