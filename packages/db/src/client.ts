import { createHash } from "node:crypto";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = new URL("./migrations", import.meta.url).pathname;
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = new URL("./migrations/meta/_journal.json", import.meta.url).pathname;

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations";
    };

export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = postgres(url, { max: 1 });
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      await runInTransaction(sql, async () => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          await sql.unsafe(statement);
        }

        await recordMigrationHistoryEntry(
          sql,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
          folderMillisByFileName.get(migrationFile) ?? Date.now(),
        );
      });
    }
  } finally {
    await sql.end();
  }
}

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
        AND column_name = ${columnName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = postgres(url, { max: 1 });
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = postgres(url, { max: 1 });

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export async function applyPendingMigrations(url: string): Promise<void> {
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  const sql = postgres(url, { max: 1 });

  try {
    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after attempted apply; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = postgres(url, { max: 1 });

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    const migrationsFolder = new URL("./migrations", import.meta.url).pathname;
    await migratePg(db, { migrationsFolder });

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = postgres(url, { max: 1 });
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}"`);
    return "created";
  } finally {
    await sql.end();
  }
}

export type EnsureRuntimeRoleOptions = {
  /** Username for the runtime role. Defaults to "paperclip_runtime". */
  roleName?: string;
  /** Plain-text password for the runtime role. Required. */
  password: string;
};

/**
 * Ensures a low-privilege "runtime" PostgreSQL role exists on the same database
 * the migration credentials connect to. The role can SELECT/INSERT/UPDATE/DELETE
 * on tables in the `public` schema (current and future) but cannot perform DDL
 * (CREATE/DROP/ALTER/TRUNCATE) — so an SQL-injection or buggy code path can't
 * wipe the schema or escalate privileges.
 *
 * Must be called with a connection that has sufficient privileges to CREATE
 * ROLE / GRANT (typically the migration superuser).
 */
export async function ensureRuntimeRole(
  migrationUrl: string,
  options: EnsureRuntimeRoleOptions,
): Promise<{ roleName: string; databaseName: string }> {
  const roleName = options.roleName ?? "paperclip_runtime";
  if (!isSafeIdentifier(roleName)) {
    throw new Error(`Unsafe runtime role name: ${roleName}`);
  }
  if (!options.password || options.password.length === 0) {
    throw new Error("ensureRuntimeRole requires a non-empty password");
  }

  const quotedRole = quoteIdentifier(roleName);
  const literalRoleName = quoteLiteral(roleName);
  const literalPassword = quoteLiteral(options.password);

  const sql = postgres(migrationUrl, { max: 1 });
  try {
    const dbRows = await sql<{ datname: string }[]>`SELECT current_database() AS datname`;
    const databaseName = dbRows[0]?.datname;
    if (!databaseName || !isSafeIdentifier(databaseName)) {
      throw new Error(`Unable to determine current database name (got: ${databaseName ?? "<null>"})`);
    }
    const quotedDb = quoteIdentifier(databaseName);

    // Create or update the runtime role with the requested password.
    // Using a DO block keeps creation/update idempotent in a single round-trip.
    // The dollar-quote tag must be one that cannot appear inside the embedded
    // password literal, so we use a long fixed tag rather than the bare `$$`
    // form. (Postgres's lexer otherwise scans for the literal next `$$`,
    // including inside string literals, so a `$$` inside the password would
    // prematurely terminate the dollar-quoted block.)
    const doTag = "$paperclip_runtime_role_setup$";
    if (options.password.includes(doTag)) {
      throw new Error(
        "Runtime password contains the reserved dollar-quote tag; choose a different password",
      );
    }
    await sql.unsafe(
      `DO ${doTag}
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literalRoleName}) THEN
    CREATE ROLE ${quotedRole} LOGIN PASSWORD ${literalPassword};
  ELSE
    ALTER ROLE ${quotedRole} WITH LOGIN PASSWORD ${literalPassword};
  END IF;
END${doTag};`,
    );

    // Restrict the runtime role to DML on the application schema only.
    // Order matters: revoke broad privileges first, then grant the narrow set
    // we want, then re-revoke any DDL on the schema.
    await sql.unsafe(`REVOKE ALL ON DATABASE ${quotedDb} FROM ${quotedRole}`);
    await sql.unsafe(`GRANT CONNECT ON DATABASE ${quotedDb} TO ${quotedRole}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${quotedRole}`);

    // The drizzle migration journal lives in its own schema; runtime queries
    // never touch it but we grant USAGE so the runtime role can still resolve
    // names without surprising errors if anything reads from it.
    const drizzleSchemaExists = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle'
      ) AS exists
    `;
    if (drizzleSchemaExists[0]?.exists) {
      await sql.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${quotedRole}`);
    }

    // DML access for all currently-existing tables/sequences in the public schema.
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quotedRole}`,
    );
    await sql.unsafe(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${quotedRole}`);

    // Default privileges only apply to objects created *by the same role* that
    // ran ALTER DEFAULT PRIVILEGES. Apply them for the current session role so
    // any future migrations (run as the migration superuser) automatically
    // grant DML access to the runtime role.
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quotedRole}`,
    );
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO ${quotedRole}`,
    );

    // Belt-and-braces: explicitly revoke CREATE on the public schema so the
    // runtime role can never add objects (and therefore can't write triggers
    // or functions that escalate privileges).
    await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${quotedRole}`);

    return { roleName, databaseName };
  } finally {
    await sql.end();
  }
}

/**
 * Returns a copy of the given PostgreSQL connection string with the user and
 * password swapped to the runtime role. The database, host, port, search params,
 * and any other URL components are preserved.
 */
export function buildRuntimeConnectionString(
  migrationUrl: string,
  runtimeUser: string,
  runtimePassword: string,
): string {
  if (!isSafeIdentifier(runtimeUser)) {
    throw new Error(`Unsafe runtime role name: ${runtimeUser}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(migrationUrl);
  } catch (err) {
    throw new Error(
      `Cannot parse DATABASE_URL as a URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  parsed.username = encodeURIComponent(runtimeUser);
  parsed.password = encodeURIComponent(runtimePassword);
  return parsed.toString();
}

export type Db = ReturnType<typeof createDb>;
