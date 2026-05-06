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

  const keepWeekBuckets = new Set<string>();
  const keepMonthBuckets = new Set<string>();
  const toDelete: string[] = [];

  for (const entry of entries) {
    // Daily tier — keep everything within dailyDays
    if (entry.mtimeMs >= dailyCutoff) continue;

    const date = new Date(entry.mtimeMs);
    const week = isoWeekKey(date);
    const month = monthKey(date);

    // Weekly tier — keep newest per calendar week
    if (entry.mtimeMs >= weeklyCutoff) {
      if (keepWeekBuckets.has(week)) {
        toDelete.push(entry.fullPath);
      } else {
        keepWeekBuckets.add(week);
      }
      continue;
    }

    // Monthly tier — keep newest per calendar month
    if (entry.mtimeMs >= monthlyCutoff) {
      if (keepMonthBuckets.has(month)) {
        toDelete.push(entry.fullPath);
      } else {
        keepMonthBuckets.add(month);
      }
      continue;
    }

    // Beyond all retention tiers — delete
    toDelete.push(entry.fullPath);
  }

  for (const filePath of toDelete) {
    unlinkSync(filePath);
  }

  return toDelete.length;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function formatSqlLiteral(value: string): string {
  const sanitized = value.replace(/\u0000/g, "");
  let tag = "$paperclip$";
  while (sanitized.includes(tag)) {
    tag = `$paperclip_${Math.random().toString(36).slice(2, 8)}$`;
  }
  return `${tag}${sanitized}${tag}`;
}

function normalizeTableNameSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map(normalizeTableSelector)
      .filter((value) => value.length > 0),
  );
}

function normalizeTableSelector(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  return trimmed.includes(".") ? trimmed : tableKey("public", trimmed);
}

function normalizeNullifyColumnMap(values: Record<string, string[]> | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!values) return out;
  for (const [tableName, columns] of Object.entries(values)) {
    const normalizedTable = normalizeTableSelector(tableName);
    if (normalizedTable.length === 0) continue;
    const normalizedColumns = new Set(
      columns
        .map((column) => column.trim())
        .filter((column) => column.length > 0),
    );
    if (normalizedColumns.size > 0) {
      out.set(normalizedTable, normalizedColumns);
    }
  }
  return out;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteQualifiedName(schemaName: string, objectName: string): string {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
}

function tableKey(schemaName: string, tableName: string): string {
  return `${schemaName}.${tableName}`;
}

function nonSystemSchemaPredicate(identifier: string): string {
  // PostgreSQL reserves pg_ prefixes for system schemas, including temp/toast variants.
  return `${identifier} <> 'information_schema'
    AND ${identifier} NOT LIKE 'pg\\_%' ESCAPE '\\'`;
}

function hasBackupTransforms(opts: RunDatabaseBackupOptions): boolean {
  return (opts.excludeTables?.length ?? 0) > 0 ||
    Object.keys(opts.nullifyColumns ?? {}).length > 0;
}

function formatSqlValue(rawValue: unknown, columnName: string | undefined, nullifiedColumns: Set<string>): string {
  const val = columnName && nullifiedColumns.has(columnName) ? null : rawValue;
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (val instanceof Date) return formatSqlLiteral(val.toISOString());
  if (typeof val === "object") return formatSqlLiteral(JSON.stringify(val));
  return formatSqlLiteral(String(val));
}

function appendCapturedStderr(previous: string, chunk: Buffer | string): string {
  const next = previous + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
  if (Buffer.byteLength(next, "utf8") <= BACKUP_CLI_STDERR_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-BACKUP_CLI_STDERR_BYTES).toString("utf8");
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapturedStderr(stderr, chunk);
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (result.signal) {
    throw new Error(`${label} exited via ${result.signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
  }
}

async function runPgDumpBackup(opts: {
  connectionString: string;
  backupFile: string;
  connectTimeout: number;
}): Promise<void> {
  const pgDumpBin = process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump";
  const child = spawn(
    pgDumpBin,
    [
      `--dbname=${opts.connectionString}`,
      "--format=plain",
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-privileges",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(opts.connectTimeout),
      },
    },
  );

  if (!child.stdout) {
    throw new Error("pg_dump did not expose stdout");
  }

  await Promise.all([
    pipeline(child.stdout, createGzip(), createWriteStream(opts.backupFile)),
    waitForChildExit(child, pgDumpBin),
  ]);
}

async function restoreWithPsql(opts: RunDatabaseRestoreOptions, connectTimeout: number): Promise<void> {
  const psqlBin = process.env.PAPERCLIP_PSQL_PATH || "psql";
  const child = spawn(
    psqlBin,
    [
      `--dbname=${opts.connectionString}`,
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--no-psqlrc",
    ],
    {
      stdio: ["pipe", "ignore", "pipe"],
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: String(connectTimeout),
      },
    },
  );

  if (!child.stdin) {
    throw new Error("psql did not expose stdin");
  }

  const input = opts.backupFile.endsWith(".gz")
    ? createReadStream(opts.backupFile).pipe(createGunzip())
    : createReadStream(opts.backupFile);

  await Promise.all([
    pipeline(input, child.stdin),
    waitForChildExit(child, psqlBin),
  ]);
}

async function hasStatementBreakpoints(backupFile: string): Promise<boolean> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  let text = "";

  try {
    for await (const chunk of stream) {
      text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      if (text.includes(STATEMENT_BREAKPOINT)) return true;
      if (Buffer.byteLength(text, "utf8") >= BACKUP_BREAKPOINT_DETECT_BYTES) return false;
    }
    return text.includes(STATEMENT_BREAKPOINT);
  } finally {
    stream.destroy();
    raw.destroy();
  }
}

async function* readRestoreStatements(backupFile: string): AsyncGenerator<string> {
  const raw = createReadStream(backupFile);
  const stream = backupFile.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  stream.setEncoding("utf8");
  const reader = createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let statementLines: string[] = [];

  const flushStatement = () => {
    const statement = statementLines.join("\n").trim();
    statementLines = [];
    return statement;
  };

  try {
    for await (const line of reader) {
      if (line === STATEMENT_BREAKPOINT) {
        const statement = flushStatement();
        if (statement.length > 0) {
          yield statement;
        }
        continue;
      }
      statementLines.push(line);
    }

    const trailingStatement = flushStatement();
    if (trailingStatement.length > 0) {
      yield trailingStatement;
    }
  } finally {
    reader.close();
    stream.destroy();
    raw.destroy();
  }
}

export function createBufferedTextFileWriter(filePath: string, maxBufferedBytes = DEFAULT_BACKUP_WRITE_BUFFER_BYTES) {
  const filePromise = openFile(filePath, "w");
  const flushThreshold = Math.max(1, Math.trunc(maxBufferedBytes));
  let bufferedLines: string[] = [];
  let bufferedBytes = 0;
  let firstChunk = true;
  let closed = false;
  let pendingWrite = Promise.resolve();

  const writeChunk = async (chunk: string | Buffer): Promise<void> => {
    const file = await filePromise;
    if (typeof chunk === "string") {
      await file.write(chunk, null, "utf8");
    } else {
      await file.write(chunk);
    }
  };

  const flushBufferedLines = () => {
    if (bufferedLines.length === 0) return;
    const linesToWrite = bufferedLines;
    bufferedLines = [];
    bufferedBytes = 0;
    const chunkBody = linesToWrite.join("\n");
    const chunk = firstChunk ? chunkBody : `\n${chunkBody}`;
    firstChunk = false;
    pendingWrite = pendingWrite.then(() => writeChunk(chunk));
  };

  return {
    emit(line: string) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      bufferedLines.push(line);
      bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      if (bufferedBytes >= flushThreshold) {
        flushBufferedLines();
      }
    },
    async drain() {
      if (closed) {
        throw new Error(`Cannot drain closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      await pendingWrite;
    },
    async writeRaw(chunk: string | Buffer) {
      if (closed) {
        throw new Error(`Cannot write to closed backup file: ${filePath}`);
      }
      flushBufferedLines();
      firstChunk = false;
      pendingWrite = pendingWrite.then(() => writeChunk(chunk));
      await pendingWrite;
    },
    async close() {
      if (closed) return;
      closed = true;
      flushBufferedLines();
      await pendingWrite;
      const file = await filePromise;
      await file.close();
    },
    async abort() {
      if (closed) return;
      closed = true;
      bufferedLines = [];
      bufferedBytes = 0;
      await pendingWrite.catch(() => {});
      await filePromise.then((file) => file.close()).catch(() => {});
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Preserve the original backup failure if temporary file cleanup also fails.
        }
      }
    },
  };
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retention = opts.retention;
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const backupEngine = opts.backupEngine ?? "auto";
  const canUsePgDump = !hasBackupTransforms(opts);
  const excludedTableNames = normalizeTableNameSet(opts.excludeTables);
  const nullifiedColumnsByTable = normalizeNullifyColumnMap(opts.nullifyColumns);
  let sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
  let sqlClosed = false;
  const closeSql = async () => {
    if (sqlClosed) return;
    sqlClosed = true;
    await sql.end();
  };
  mkdirSync(opts.backupDir, { recursive: true });
  const sqlFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql`);
  const backupFile = `${sqlFile}.gz`;
  const writer = createBufferedTextFileWriter(sqlFile);

  try {
    if (backupEngine === "pg_dump" || (backupEngine === "auto" && canUsePgDump)) {
      await sql`SELECT 1`;
      try {
        await closeSql();
        await runPgDumpBackup({
          connectionString: opts.connectionString,
          backupFile,
          connectTimeout,
        });
        await writer.abort();
        const sizeBytes = statSync(backupFile).size;
        const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);
        return {
          backupFile,
          sizeBytes,
          prunedCount,
        };
      } catch (error) {
        if (existsSync(backupFile)) {
          try { unlinkSync(backupFile); } catch { /* ignore */ }
        }
        if (backupEngine === "pg_dump") {
          throw error;
        }
        sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        sqlClosed = false;
      }
    }

    await sql`SELECT 1`;

    const emit = (line: string) => writer.emit(line);
    const emitStatement = (statement: string) => {
      emit(statement);
      emit(STATEMENT_BREAKPOINT);
    };
    const emitStatementBoundary = () => {
      emit(STATEMENT_BREAKPOINT);
    };

    emit("-- Paperclip database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emitStatement("BEGIN;");
    emitStatement("SET LOCAL session_replication_role = replica;");
    emitStatement("SET LOCAL client_min_messages = warning;");
    emit("");

    const allTables = await sql<TableDefinition[]>`
      SELECT table_schema AS schema_name, table_name AS tablename
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND ${sql.unsafe(nonSystemSchemaPredicate("table_schema"))}
      ORDER BY table_schema, table_name
    `;
    const tables = allTables;
    const includedTableNames = new Set(tables.map(({ schema_name, tablename }) => tableKey(schema_name, tablename)));
    const includedSchemas = new Set(tables.map(({ schema_name }) => schema_name));

    // Get all enums
    const enums = await sql<{ schema_name: string; typname: string; labels: string[] }[]>`
      SELECT n.nspname AS schema_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname
    `;
    for (const e of enums) includedSchemas.add(e.schema_name);

    const allSequences = await sql<SequenceDefinition[]>`
      SELECT
        s.sequence_schema,
        s.sequence_name,
        s.data_type,
        s.start_value,
        s.minimum_value,
        s.maximum_value,
        s.increment,
        s.cycle_option,
        tblns.nspname AS owner_schema,
        tbl.relname AS owner_table,
        attr.attname AS owner_column
      FROM information_schema.sequences s
      JOIN pg_class seq ON seq.relname = s.sequence_name
      JOIN pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = s.sequence_schema
      LEFT JOIN pg_depend dep ON dep.objid = seq.oid AND dep.deptype = 'a'
      LEFT JOIN pg_class tbl ON tbl.oid = dep.refobjid
      LEFT JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
      LEFT JOIN pg_attribute attr ON attr.attrelid = tbl.oid AND attr.attnum = dep.refobjsubid
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("s.sequence_schema"))}
      ORDER BY s.sequence_schema, s.sequence_name
    `;
    const sequences = allSequences.filter(
      (seq) => !seq.owner_table || includedTableNames.has(tableKey(seq.owner_schema ?? "public", seq.owner_table)),
    );

    const schemas = new Set<string>(includedSchemas);
    for (const seq of sequences) schemas.add(seq.sequence_schema);
    const extraSchemas = [...schemas].filter((schemaName) => schemaName !== "public");
    if (extraSchemas.length > 0) {
      emit("-- Schemas");
      for (const schemaName of extraSchemas) {
        emitStatement(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schemaName)};`);
      }
      emit("");
    }

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emitStatement(`CREATE TYPE ${quoteQualifiedName(e.schema_name, e.typname)} AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const extensions = await sql<ExtensionDefinition[]>`
      SELECT
        e.extname AS extension_name,
        n.nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      WHERE e.extname <> 'plpgsql'
      ORDER BY e.extname
    `;
    if (extensions.length > 0) {
      emit("-- Extensions");
      for (const extension of extensions) {
        emitStatement(
          `CREATE EXTENSION IF NOT EXISTS ${quoteIdentifier(extension.extension_name)} WITH SCHEMA ${quoteIdentifier(extension.schema_name)};`,
        );
      }
      emit("");
    }

    if (sequences.length > 0) {
      emit("-- Sequences");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        emitStatement(`DROP SEQUENCE IF EXISTS ${qualifiedSequenceName} CASCADE;`);
        emitStatement(
          `CREATE SEQUENCE ${qualifiedSequenceName} AS ${seq.data_type} INCREMENT BY ${seq.increment} MINVALUE ${seq.minimum_value} MAXVALUE ${seq.maximum_value} START WITH ${seq.start_value}${seq.cycle_option === "YES" ? " CYCLE" : " NO CYCLE"};`,
        );
      }
      emit("");
    }

    // Get full CREATE TABLE DDL via column info
    for (const { schema_name, tablename } of tables) {
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const columns = await sql<{
        column_name: string;
        data_type: string;
        udt_schema: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]>`
        SELECT column_name, data_type, udt_schema, udt_name, is_nullable, column_default,
               character_maximum_length, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;

      emit(`-- Table: ${schema_name}.${tablename}`);
      emitStatement(`DROP TABLE IF EXISTS ${qualifiedTableName} CASCADE;`);

      const colDefs: string[] = [];
      for (const col of columns) {
        let typeStr: string;
        if (col.data_type === "USER-DEFINED") {
          typeStr = quoteQualifiedName(col.udt_schema, col.udt_name);
        } else if (col.data_type === "ARRAY") {
          const elementType = col.udt_name.replace(/^_/, "");
          typeStr = col.udt_schema === "pg_catalog"
            ? `${elementType}[]`
            : `${quoteQualifiedName(col.udt_schema, elementType)}[]`;
        } else if (col.data_type === "character varying") {
          typeStr = col.character_maximum_length
            ? `varchar(${col.character_maximum_length})`
            : "varchar";
        } else if (col.data_type === "numeric" && col.numeric_precision != null) {
          typeStr =
            col.numeric_scale != null
              ? `numeric(${col.numeric_precision}, ${col.numeric_scale})`
              : `numeric(${col.numeric_precision})`;
        } else {
          typeStr = col.data_type;
        }

        let def = `  "${col.column_name}" ${typeStr}`;
        if (col.column_default != null) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === "NO") def += " NOT NULL";
        colDefs.push(def);
      }

      // Primary key
      const pk = await sql<{ constraint_name: string; column_names: string[] }[]>`
        SELECT c.conname AS constraint_name,
               array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE n.nspname = ${schema_name} AND t.relname = ${tablename} AND c.contype = 'p'
        GROUP BY c.conname
      `;
      for (const p of pk) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        colDefs.push(`  CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols})`);
      }

      emit(`CREATE TABLE ${qualifiedTableName} (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emitStatementBoundary();
      emit("");
    }

    const ownedSequences = sequences.filter((seq) => seq.owner_table && seq.owner_column);
    if (ownedSequences.length > 0) {
      emit("-- Sequence ownership");
      for (const seq of ownedSequences) {
        emitStatement(
          `ALTER SEQUENCE ${quoteQualifiedName(seq.sequence_schema, seq.sequence_name)} OWNED BY ${quoteQualifiedName(seq.owner_schema ?? "public", seq.owner_table!)}.${quoteIdentifier(seq.owner_column!)};`,
        );
      }
      emit("");
    }

    // Foreign keys (after all tables created)
    const allForeignKeys = await sql<{
      constraint_name: string;
      source_schema: string;
      source_table: string;
      source_columns: string[];
      target_schema: string;
      target_table: string;
      target_columns: string[];
      update_rule: string;
      delete_rule: string;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        srcn.nspname AS source_schema,
        src.relname AS source_table,
        array_agg(sa.attname ORDER BY array_position(c.conkey, sa.attnum)) AS source_columns,
        tgtn.nspname AS target_schema,
        tgt.relname AS target_table,
        array_agg(ta.attname ORDER BY array_position(c.confkey, ta.attnum)) AS target_columns,
        CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
        CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_namespace srcn ON srcn.oid = src.relnamespace
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace tgtn ON tgtn.oid = tgt.relnamespace
      JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = ANY(c.conkey)
      JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = ANY(c.confkey)
      WHERE c.contype = 'f'
        AND ${sql.unsafe(nonSystemSchemaPredicate("srcn.nspname"))}
      GROUP BY c.conname, srcn.nspname, src.relname, tgtn.nspname, tgt.relname, c.confupdtype, c.confdeltype
      ORDER BY srcn.nspname, src.relname, c.conname
    `;
    const fks = allForeignKeys.filter(
      (fk) => includedTableNames.has(tableKey(fk.source_schema, fk.source_table))
        && includedTableNames.has(tableKey(fk.target_schema, fk.target_table)),
    );

    if (fks.length > 0) {
      emit("-- Foreign keys");
      for (const fk of fks) {
        const srcCols = fk.source_columns.map((c) => `"${c}"`).join(", ");
        const tgtCols = fk.target_columns.map((c) => `"${c}"`).join(", ");
        emitStatement(
          `ALTER TABLE ${quoteQualifiedName(fk.source_schema, fk.source_table)} ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY (${srcCols}) REFERENCES ${quoteQualifiedName(fk.target_schema, fk.target_table)} (${tgtCols}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`,
        );
      }
      emit("");
    }

    // Unique constraints
    const allUniqueConstraints = await sql<{
      constraint_name: string;
      schema_name: string;
      tablename: string;
      column_names: string[];
    }[]>`
      SELECT c.conname AS constraint_name,
             n.nspname AS schema_name,
             t.relname AS tablename,
             array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'u'
        AND ${sql.unsafe(nonSystemSchemaPredicate("n.nspname"))}
      GROUP BY c.conname, n.nspname, t.relname
      ORDER BY n.nspname, t.relname, c.conname
    `;
    const uniques = allUniqueConstraints.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (uniques.length > 0) {
      emit("-- Unique constraints");
      for (const u of uniques) {
        const cols = u.column_names.map((c) => `"${c}"`).join(", ");
        emitStatement(`ALTER TABLE ${quoteQualifiedName(u.schema_name, u.tablename)} ADD CONSTRAINT "${u.constraint_name}" UNIQUE (${cols});`);
      }
      emit("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const allIndexes = await sql<{ schema_name: string; tablename: string; indexdef: string }[]>`
      SELECT schemaname AS schema_name, tablename, indexdef
      FROM pg_indexes
      WHERE ${sql.unsafe(nonSystemSchemaPredicate("schemaname"))}
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = pg_indexes.schemaname
        )
      ORDER BY schemaname, tablename, indexname
    `;
    const indexes = allIndexes.filter((entry) => includedTableNames.has(tableKey(entry.schema_name, entry.tablename)));

    if (indexes.length > 0) {
      emit("-- Indexes");
      for (const idx of indexes) {
        emitStatement(`${idx.indexdef};`);
      }
      emit("");
    }

    // Dump data for each table
    for (const { schema_name, tablename } of tables) {
      const currentTableKey = tableKey(schema_name, tablename);
      const qualifiedTableName = quoteQualifiedName(schema_name, tablename);
      const count = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${qualifiedTableName}`);
      if (excludedTableNames.has(currentTableKey) || (count[0]?.n ?? 0) === 0) continue;

      // Get column info for this table
      const cols = await sql<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = ${schema_name} AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${schema_name}.${tablename} (${count[0]!.n} rows)`);

      const nullifiedColumns = nullifiedColumnsByTable.get(currentTableKey) ?? new Set<string>();
      if (backupEngine !== "javascript" && nullifiedColumns.size === 0) {
        emit(`COPY ${qualifiedTableName} (${colNames}) FROM stdin;`);
        await writer.writeRaw("\n");
        const copySql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });
        try {
          const copyStream = await copySql
            .unsafe(`COPY ${qualifiedTableName} (${colNames}) TO STDOUT`)
            .readable();
          for await (const chunk of copyStream) {
            await writer.writeRaw(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
        } finally {
          await copySql.end();
        }
        await writer.writeRaw("\\.\n");
        emitStatementBoundary();
        emit("");
        continue;
      }

      const rowCursor = sql
        .unsafe(`SELECT * FROM ${qualifiedTableName}`)
        .values()
        .cursor(BACKUP_DATA_CURSOR_ROWS) as AsyncIterable<unknown[][]>;
      for await (const rows of rowCursor) {
        for (const row of rows) {
          const values = row.map((rawValue, index) =>
            formatSqlValue(rawValue, cols[index]?.column_name, nullifiedColumns),
          );
          emitStatement(`INSERT INTO ${qualifiedTableName} (${colNames}) VALUES (${values.join(", ")});`);
        }
        await writer.drain();
      }
      emit("");
    }

    // Sequence values
    if (sequences.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequences) {
        const qualifiedSequenceName = quoteQualifiedName(seq.sequence_schema, seq.sequence_name);
        const val = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
          `SELECT last_value::text, is_called FROM ${qualifiedSequenceName}`,
        );
        const skipSequenceValue =
          seq.owner_table !== null
            && excludedTableNames.has(seq.owner_table);
        if (val[0] && !skipSequenceValue) {
          emitStatement(`SELECT setval('${qualifiedSequenceName.replaceAll("'", "''")}', ${val[0].last_value}, ${val[0].is_called ? "true" : "false"});`);
        }
      }
      emit("");
    }

    emitStatement("COMMIT;");
    emit("");

    await writer.close();

    // Compress the SQL file with gzip
    const sqlReadStream = createReadStream(sqlFile);
    const gzWriteStream = createWriteStream(backupFile);
    await pipeline(sqlReadStream, createGzip(), gzWriteStream);
    unlinkSync(sqlFile);

    const sizeBytes = statSync(backupFile).size;
    const prunedCount = pruneOldBackups(opts.backupDir, retention, filenamePrefix);

    return {
      backupFile,
      sizeBytes,
      prunedCount,
    };
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
