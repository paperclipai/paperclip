import { createHash } from "node:crypto";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

/**
 * Fixed Postgres advisory-lock key pair used to serialize the
 * check-then-insert sequence in `reconcilePendingMigrationHistory()` that
 * inserts a brand-new `__drizzle_migrations` row when no existing row (and
 * no repairable stale orphan) is found for a migration's hash/name. There is
 * no UNIQUE constraint on `hash` for `ON CONFLICT DO NOTHING` to key off of,
 * so this is the only thing preventing two concurrent ECS replicas from both
 * observing "no row yet" and both inserting a duplicate. A single fixed key
 * (rather than one derived per migration) is sufficient because
 * reconciliation only ever reaches the insert branch for at most one
 * migration per call in practice, and serializing the whole operation across
 * replicas costs nothing meaningful on this rarely-run, startup-time path.
 * Using the two-int32 overload of `pg_advisory_xact_lock` avoids bigint
 * precision pitfalls of passing a single 64-bit key through JS numbers.
 *
 * IMPORTANT: this exact `(0x706c6970, 1)` key pair is reserved for
 * migration-reconciliation locking only. The two-int4 `pg_advisory_lock` /
 * `pg_advisory_xact_lock` overload shares a single lock-key namespace across
 * an entire Postgres database, so any other code taking an advisory lock via
 * that same two-int4 overload must use a different key pair - do not reuse
 * `MIGRATION_RECONCILE_INSERT_LOCK_KEYS` (or the literal `0x706c6970, 1`) for
 * application-level locking elsewhere.
 */
export const MIGRATION_RECONCILE_INSERT_LOCK_KEYS: readonly [number, number] = [0x706c6970, 1];

function createUtilitySql(url: string) {
  return postgres(url, { max: 1, onnotice: () => {} });
}

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

/**
 * Strips a trailing `--` line comment from each line of `text`,
 * line-by-line, BEFORE any whitespace-collapsing normalization runs. This
 * must happen per-line, on the raw (newline-preserving) text: if newlines
 * were collapsed to spaces first, a `--` comment on one line would have
 * nothing to stop it from swallowing real SQL that originally lived on a
 * later line, since `.` in `--.*`-style matching does not stop at spaces.
 *
 * Does not track single-quoted string literals - a `--` inside a SQL string
 * literal will be incorrectly treated as a comment. If migration SQL ever
 * needs `--` inside a string literal, this function needs a quote-aware
 * rewrite.
 */
function stripSqlLineComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const commentIndex = line.indexOf("--");
      return commentIndex === -1 ? line : line.slice(0, commentIndex);
    })
    .join("\n");
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

export interface DatabaseClientOptions {
  /**
   * postgres.js `prepare`. Set false when connecting through a
   * transaction-mode pooler (pgbouncer / Neon `-pooler` endpoints /
   * Supabase Supavisor transaction ports) so the client does not rely on
   * session-scoped prepared statements. Defaults to the driver default
   * (enabled), preserving existing behavior on direct connections.
   */
  prepare?: boolean;
  /** postgres.js `max` — connection pool size (driver default: 10). */
  maxConnections?: number;
  /** postgres.js `idle_timeout` in seconds (driver default: disabled). */
  idleTimeoutSeconds?: number;
  /** postgres.js `connect_timeout` in seconds (driver default: 30). */
  connectTimeoutSeconds?: number;
}

function envBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be "true" or "false", got: ${env[name]}`);
}

function envPositiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer, got: ${env[name]}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * Database client tuning from the environment, so hosted deployments can
 * adapt to their connection topology (pooled endpoints, network latency)
 * without editing source. Every variable is optional; when unset the
 * driver defaults apply and behavior is identical to a bare
 * `postgres(url)` — self-hosted setups need none of these.
 */
export function databaseClientOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseClientOptions {
  const options: DatabaseClientOptions = {};
  const prepare = envBoolean(env, "DATABASE_PREPARED_STATEMENTS");
  if (prepare !== undefined) options.prepare = prepare;
  const maxConnections = envPositiveInteger(env, "DATABASE_POOL_MAX");
  if (maxConnections !== undefined) options.maxConnections = maxConnections;
  const idleTimeoutSeconds = envPositiveInteger(env, "DATABASE_IDLE_TIMEOUT_SECONDS");
  if (idleTimeoutSeconds !== undefined) options.idleTimeoutSeconds = idleTimeoutSeconds;
  const connectTimeoutSeconds = envPositiveInteger(env, "DATABASE_CONNECT_TIMEOUT_SECONDS");
  if (connectTimeoutSeconds !== undefined) options.connectTimeoutSeconds = connectTimeoutSeconds;
  return options;
}

export function postgresJsOptions(options: DatabaseClientOptions): Record<string, unknown> {
  const driverOptions: Record<string, unknown> = {};
  if (options.prepare !== undefined) driverOptions.prepare = options.prepare;
  if (options.maxConnections !== undefined) driverOptions.max = options.maxConnections;
  if (options.idleTimeoutSeconds !== undefined) driverOptions.idle_timeout = options.idleTimeoutSeconds;
  if (options.connectTimeoutSeconds !== undefined) driverOptions.connect_timeout = options.connectTimeoutSeconds;
  return driverOptions;
}

export function createDb(url: string, options?: DatabaseClientOptions) {
  const resolved = options ?? databaseClientOptionsFromEnv();
  const sql = postgres(url, postgresJsOptions(resolved));
  return drizzlePg(sql, { schema });
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
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

/**
 * Runs `action` inside a Postgres transaction using postgres.js's native
 * `sql.begin()` API, which reserves a single physical connection for the
 * duration of the callback and issues BEGIN/COMMIT/ROLLBACK on that
 * reserved connection automatically. `action` receives that
 * connection-scoped executor (`tx` below) and MUST use it (not the
 * outer `sql`) for every query it runs, so that statements like
 * `pg_advisory_xact_lock` - which only serializes callers when run on the
 * same connection as the surrounding transaction - are guaranteed to share
 * a connection with the rest of the transaction. This makes that
 * connection-affinity guarantee an explicit, structural property of
 * `sql.begin()` rather than an implicit side effect of the utility pool
 * happening to be configured with `max: 1` (see `createUtilitySql`).
 *
 * Error/rollback semantics match the previous hand-rolled
 * BEGIN/COMMIT/ROLLBACK implementation: `sql.begin()` rolls back the
 * transaction if `action` throws and rethrows the original error.
 */
async function runInTransaction(
  sql: ReturnType<typeof postgres>,
  action: (tx: SqlExecutor) => Promise<void>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await action(tx);
  });
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

  const sql = createUtilitySql(url);
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

      await runInTransaction(sql, async (tx) => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          await tx.unsafe(statement);
        }

        await recordMigrationHistoryEntry(
          tx,
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

/**
 * Scoped to `tableName` (in addition to the `public` schema and `relkind`)
 * so that an index of this name existing on some OTHER table does not cause
 * a false "already applied" for the DDL statement that targets THIS table.
 * Without this, a chunk with multiple `CREATE INDEX` statements targeting
 * different tables (e.g. `0182_connections_v3_schema_core.sql`) could have
 * every statement in it resolve `true` purely because each index name
 * happened to exist somewhere in `public`, even if none of them existed on
 * the specific table the migration actually targets - silently marking real
 * DDL as already-applied when it never ran. Joined via `pg_index.indrelid`
 * (the table an index belongs to) rather than name-matching alone, matching
 * how `constraintExists` below is scoped via `pg_constraint.conrelid`.
 */
async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_class t ON t.oid = i.indrelid
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
        AND t.relname = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Scoped to `tableName` (in addition to the `public` schema) so that a
 * constraint of this name existing on some OTHER table does not cause a
 * false "already applied" for the DDL statement that targets THIS table.
 * Real migrations routinely emit several `ADD CONSTRAINT` statements per
 * chunk (e.g. `0182_connections_v3_schema_core.sql`); without table-scoping,
 * every statement in such a chunk could resolve `true` purely because a
 * same-named constraint exists on some unrelated table, marking the whole
 * chunk (and therefore the whole migration) as already-applied in the
 * journal even though the real DDL never ran against its actual target
 * table - silent schema drift with no error surfaced anywhere. Joined via
 * `pg_constraint.conrelid` (the table a constraint belongs to) rather than
 * name-matching alone.
 */
async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
        AND t.relname = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

/**
 * Splits comment-stripped SQL text into its constituent individual
 * statements on top-level `;` terminators, collapsing internal whitespace
 * and dropping empty fragments. This exists because a single chunk handed to
 * `migrationStatementAlreadyApplied()` (a chunk being whatever
 * `splitMigrationStatements()` produced by splitting on `-->
 * statement-breakpoint`) can legitimately contain MORE than one real SQL
 * statement: real migrations in this repo (e.g.
 * `0182_connections_v3_schema_core.sql`) routinely emit several `ALTER
 * TABLE ... ADD COLUMN` statements - or a `SET ...;` followed by real DDL -
 * back to back with no `--> statement-breakpoint` between them. Each must be
 * checked independently rather than only inspecting the chunk's first
 * statement.
 *
 * This is NOT a full SQL parser - it only tracks single-quoted string
 * literals (`'...'`, with `''` handled as an escaped quote) and
 * dollar-quoted blocks (`$$...$$`, e.g. a `DO $$ ... END $$;` body) so a
 * semicolon that appears *inside* either of those is not mistaken for a
 * statement terminator. That is sufficient for this codebase's real
 * migration content: a repo-wide check found exactly one statement with a
 * semicolon inside a string literal
 * (`0164_plugin_config_company_scope.sql`'s `RAISE EXCEPTION 'Cannot assign
 * ... row(s); resolve ...'`), and it lives inside its own self-contained `DO
 * $$ ... $$;` block (already its own `--> statement-breakpoint` chunk, not
 * mixed with other statements). A bare "split on every `;`" would have cut
 * that literal apart mid-string; this does not. Building a real SQL
 * tokenizer for the general case is out of scope given that constraint.
 *
 * Only ANONYMOUS `$$...$$` dollar-quotes are recognized. Tagged variants
 * (`$body$...$body$`, `$func$...$func$`, etc.) are NOT supported and will be
 * mis-split: a tagged opener is not matched by the `$$` check below, so any
 * `;` inside a tagged dollar-quoted body - including one inside a nested
 * string literal within it - is treated as a real statement terminator. This
 * fails CLOSED, not silently wrong: splitting a tagged body apart produces
 * fragments that `singleSqlStatementAlreadyApplied()` cannot recognize, so
 * `migrationStatementAlreadyApplied()` returns `false` (triggering a retry
 * via the normal migration path), never an incorrect `true`. A repo-wide
 * grep confirmed no current migration uses tagged dollar-quotes, so this is
 * a documented limitation, not a live bug.
 */
function splitIntoIndividualSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDollarQuote = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (inSingleQuote) {
      current += char;
      if (char === "'") {
        if (text[index + 1] === "'") {
          current += text[++index];
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDollarQuote) {
      current += char;
      if (char === "$" && text[index + 1] === "$") {
        current += text[++index];
        inDollarQuote = false;
      }
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      current += char;
      continue;
    }

    if (char === "$" && text[index + 1] === "$") {
      inDollarQuote = true;
      current += "$$";
      index++;
      continue;
    }

    if (char === ";") {
      statements.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) statements.push(current);

  return statements
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Checks a single, already-isolated SQL statement (no embedded `;` of its
 * own) against the recognized shapes this module knows how to verify against
 * live schema state. Callers are responsible for isolating individual
 * statements first (see `splitIntoIndividualSqlStatements`) - this function
 * does not (and must not) need to guard against trailing content from a
 * second statement, because none is possible once isolation has happened.
 */
async function singleSqlStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  normalized: string,
): Promise<boolean> {
  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) return tableExists(sql, createTableMatch[1]);

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);

  const createIndexMatch = normalized.match(
    /^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)" ON "([^"]+)"/i,
  );
  if (createIndexMatch) return indexExists(sql, createIndexMatch[1], createIndexMatch[2]);

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) return constraintExists(sql, addConstraintMatch[2], addConstraintMatch[1]);

  // Session-scoped runtime parameters (e.g. `SET lock_timeout = '2s';`,
  // `SET LOCAL statement_timeout = '30s';`, `SET SESSION ... TO ...`) have no
  // persistent schema effect, so there is nothing to check for "already
  // applied" - they are trivially always already-applied. Because this
  // function only ever sees one isolated statement at a time (its caller has
  // already split multi-statement chunks apart), the regex can stay
  // end-anchored without needing to worry about a second statement's DDL
  // trailing behind a leading `SET ...` in the same string.
  //
  // The value-capture group (`[^;]+$`) cannot handle a SET value containing
  // a literal semicolon (e.g. `SET app.config = 'a;b';`): even though
  // `splitIntoIndividualSqlStatements()` correctly isolates such a statement
  // as one piece (it tracks single-quoted strings, so it does not split on
  // the semicolon inside `'a;b'`), the isolated statement text still
  // literally contains that embedded `;`, which `[^;]+` cannot match through
  // on the way to the end-anchor. The overall regex then fails to match, and
  // this function falls through to the `return false` below - this fails
  // CLOSED (triggers a retry via the normal migration path), not silently
  // misparsed, so it is a documented limitation for future migration authors
  // rather than a live bug. A repo-wide grep confirmed no current migration
  // sets a session parameter to a value containing a literal semicolon.
  if (/^SET\s+(?:LOCAL\s+|SESSION\s+)?[\w.]+\s*(?:=|TO)\s*[^;]+$/i.test(normalized)) {
    return true;
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

/**
 * True if every individual SQL statement inside `statement` (a chunk as
 * produced by `splitMigrationStatements()` - i.e. everything between two
 * `--> statement-breakpoint` markers, which may itself contain more than one
 * `;`-terminated statement) is independently a recognized, already-applied
 * shape. A trailing `-- paperclip:migration-safety-ignore <rule>: <reason>`
 * line comment (this codebase's real convention; see
 * check-migration-safety.ts) is stripped per-line, before statements are
 * split apart, so it can never swallow a real statement that happens to live
 * on a later line of the same chunk (stripping per-line, on
 * newline-preserving text, is required for that - collapsing newlines to
 * spaces first would let a `--` comment's `.*`-style matching run on past
 * where the original line ended).
 *
 * If even one statement in the chunk is unrecognized, or recognized but not
 * yet applied, the whole chunk is reported as NOT already-applied - matching
 * this function's existing fail-closed posture for statements it cannot
 * reason about.
 */
export async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const commentStripped = stripSqlLineComments(statement);
  const individualStatements = splitIntoIndividualSqlStatements(commentStripped);
  if (individualStatements.length === 0) return false;

  for (const individualStatement of individualStatements) {
    const applied = await singleSqlStatementAlreadyApplied(sql, individualStatement);
    if (!applied) return false;
  }

  return true;
}

export async function migrationContentAlreadyApplied(
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
  // Migrations this call found already recorded by a concurrent replica (it
  // lost the advisory-lock race, so it performed no repair itself) - as
  // opposed to `repairedMigrations`, which lists migrations THIS call
  // actually repaired. Callers must treat both as a signal to re-inspect
  // state: the DB may be fully up to date even though `repairedMigrations`
  // is empty, if another replica already recorded the row.
  alreadyRecordedByOtherReplica: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], alreadyRecordedByOtherReplica: [], remainingMigrations: [] };
  }

  const sql = createUtilitySql(url);
  const repairedMigrations: string[] = [];
  const alreadyRecordedByOtherReplica: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return {
        repairedMigrations,
        alreadyRecordedByOtherReplica,
        remainingMigrations: state.pendingMigrations,
      };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    // Hashes for every migration file currently on disk. A history row whose
    // hash matches none of these is "unresolvable" by loadAppliedMigrations()
    // - either it is stale (its migration file was renamed or its content
    // was changed after some replicas already recorded a row for the old
    // version - e.g. via a later consolidation of migrations - so the
    // recorded hash no longer matches anything on disk) or it is otherwise
    // corrupt. Either way it is a candidate to be repointed at the migration
    // we are currently reconciling instead of being left behind as a
    // permanent orphan while we INSERT a brand-new row for it. `__drizzle_
    // migrations` has no `name` column in this codebase, so there is no way
    // to confirm which specific migration a stale orphan row "belongs" to -
    // see the array-length-based handling below.
    const currentHashesToFiles = columnNames.has("hash")
      ? await mapHashesToMigrationFiles(state.availableMigrations)
      : new Map<string, string>();
    const validHashes = new Set(currentHashesToFiles.keys());

    // Fetched once up front rather than re-querying per migration: the whole
    // set of stale orphans is resolved against the whole set of unresolved
    // migrations together, below, rather than one row at a time.
    const staleOrphanOrderClauses: string[] = [];
    if (columnNames.has("created_at")) staleOrphanOrderClauses.push("created_at ASC");
    if (columnNames.has("id")) staleOrphanOrderClauses.push("id ASC");
    const staleOrphanOrderBySql =
      staleOrphanOrderClauses.length > 0 ? ` ORDER BY ${staleOrphanOrderClauses.join(", ")}` : "";

    const staleOrphanSelectColumns = ["hash"];
    if (columnNames.has("name")) staleOrphanSelectColumns.push("name");

    const staleOrphanRows = columnNames.has("hash")
      ? await sql.unsafe<{ hash: string; name?: string }[]>(
          `SELECT ${staleOrphanSelectColumns.join(", ")} FROM ${qualifiedTable}${staleOrphanOrderBySql}`,
        )
      : [];

    // First pass: classify every already-applied pending migration as either
    // already correctly recorded (bump its created_at if needed, below) or
    // "unresolved" (needs an orphan repoint or a fresh insert). The full
    // unresolved batch is collected before touching `staleOrphanRows` at all,
    // so the ambiguity check in the second pass can reason about the whole
    // batch at once instead of one migration at a time: resolving orphans
    // one migration at a time as they were encountered let processing order
    // decide which of several equally-plausible migrations claimed a shared
    // orphan, which could repoint it at the wrong migration whenever more
    // than one migration in the same pass lacked a history row.
    type UnresolvedMigration = { migrationFile: string; hash: string; folderMillis: number };
    const unresolvedMigrations: UnresolvedMigration[] = [];
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

      unresolvedMigrations.push({ migrationFile, hash, folderMillis });
    }

    // Second pass: resolve the whole unresolved batch against the stale
    // orphan rows together. Before inserting brand-new rows, look for stale
    // orphan rows left behind by a pre-rewrite hash and repoint them at the
    // current hash via UPDATE ... WHERE hash = <stale hash> rather than
    // DELETE + INSERT so the operation is race-safe under concurrent ECS
    // replicas: if two replicas race this UPDATE, only the first affects a
    // row (it moves the row's hash away from the stale value); the second
    // then matches zero rows and becomes a safe no-op instead of creating a
    // duplicate. Only rows whose hash matches none of the migrations on disk
    // are even candidates for repair. `__drizzle_migrations` has no `name`
    // column here, so there is no way to confirm which specific migration a
    // given orphan row "belongs" to - we can only reason about how the two
    // counts line up:
    //   - Zero orphans: nothing to repoint, every unresolved migration falls
    //     through to the advisory-lock-guarded INSERT path below.
    //     (A prior version of this code threw whenever any orphan existed at
    //     all, which would have blocked all subsequent migrations on any
    //     database carrying orphan rows left behind by other, unrelated,
    //     previously consolidated migrations - that must not happen.)
    //   - Orphan count equals unresolved-migration count (both nonzero): an
    //     unambiguous 1:1 correspondence. Both lists are already in
    //     chronological order (`staleOrphanRows` by created_at/id ASC,
    //     `unresolvedMigrations` by migration/journal order), so pair them
    //     positionally rather than letting whichever migration happens to be
    //     processed first claim any single remaining orphan.
    //   - Any other nonzero mismatch: genuinely ambiguous - there is no way
    //     to tell which orphan (if any) belongs to which migration, so
    //     refuse to guess and throw instead.
    const invalidOrphanIndexes = staleOrphanRows.reduce<number[]>((acc, row, index) => {
      if (!validHashes.has(row.hash)) acc.push(index);
      return acc;
    }, []);

    // Only an issue when some migration actually needs an orphan: a stale
    // orphan sitting alongside zero unresolved migrations is unrelated cruft
    // (e.g. left behind by an entirely different, already-resolved
    // consolidation) that nothing in this pass needs to claim, and must not
    // block reconciliation of migrations that don't need it at all.
    if (
      unresolvedMigrations.length > 0 &&
      invalidOrphanIndexes.length > 0 &&
      invalidOrphanIndexes.length !== unresolvedMigrations.length
    ) {
      throw new Error(
        `Cannot reconcile migration history: found ${invalidOrphanIndexes.length} stale orphan row(s) in ${qualifiedTable} with hashes that match no migration on disk, but ${unresolvedMigrations.length} pending migration(s) (${unresolvedMigrations.map((m) => m.migrationFile).join(", ")}) have no history row at all. There is no \`name\` column to determine which orphan (if any) belongs to which migration - refusing to guess. Resolve the ambiguity manually.`,
      );
    }

    const orphansByPosition = invalidOrphanIndexes.map((index) => staleOrphanRows[index]);

    for (const [position, unresolved] of unresolvedMigrations.entries()) {
      const { migrationFile, hash, folderMillis } = unresolved;
      const staleOrphan = orphansByPosition[position];

      if (staleOrphan) {
        const updateAssignments: string[] = [`hash = ${quoteLiteral(hash)}`];
        if (columnNames.has("name")) updateAssignments.push(`name = ${quoteLiteral(migrationFile)}`);
        if (columnNames.has("created_at")) {
          updateAssignments.push(`created_at = ${quoteLiteral(String(folderMillis))}`);
        }
        const updatedRows = await sql.unsafe<{ hash: string }[]>(
          `UPDATE ${qualifiedTable} SET ${updateAssignments.join(", ")} WHERE hash = ${quoteLiteral(staleOrphan.hash)} RETURNING hash`,
        );
        if (updatedRows.length > 0) {
          repairedMigrations.push(migrationFile);
          continue;
        }

        // The UPDATE matched zero rows: some other racer got to this exact
        // orphan row first (it matched on the pre-update
        // `hash = <stale hash>` WHERE clause, which only one racer can
        // satisfy). Since there is no `name` column, we cannot assume that
        // winning racer was reconciling THIS migration - it could have been
        // a different replica reconciling a different pending migration
        // that happened to see the same single orphan candidate. So we
        // cannot conclude `migrationFile` is now recorded just because we
        // lost this race; check explicitly.
        const nowRecorded = await migrationHistoryEntryExists(sql, qualifiedTable, columnNames, migrationFile, hash);
        if (nowRecorded) {
          // Our migration really was the one the winning racer recorded -
          // mirroring the INSERT path's `alreadyRecordedByOtherReplica`
          // handling below, it must not be counted in `repairedMigrations`.
          alreadyRecordedByOtherReplica.push(migrationFile);
          continue;
        }

        // The orphan we tried to claim was taken by someone reconciling a
        // different migration, and `migrationFile` itself is still
        // unrecorded. Fall through to the advisory-lock-guarded INSERT path
        // below rather than incorrectly reporting this as already handled.
      }

      if (!columnNames.has("hash") && !columnNames.has("name") && !columnNames.has("created_at")) {
        break;
      }

      // There is no UNIQUE constraint on `hash` in `__drizzle_migrations`, so
      // Postgres has no conflict to infer here - `ON CONFLICT DO NOTHING`
      // alone does NOT make this insert race-safe (it is a pure no-op
      // without a matching unique index). Concurrent races on an
      // already-recorded migration are handled above via UPDATE ... WHERE
      // hash = <stale hash>, which is safe on its own; this INSERT path is
      // reached only when no such row exists yet, which is exactly the
      // scenario where two replicas could both observe "nothing to update"
      // and both insert. Guard against that by serializing the
      // re-check-then-insert sequence with a transaction-scoped Postgres
      // advisory lock: only one replica can hold
      // MIGRATION_RECONCILE_INSERT_LOCK_KEYS at a time, so the re-check
      // immediately below is guaranteed accurate for whoever holds it, and a
      // second replica - once it acquires the lock after the first commits -
      // will see the row the first one inserted and skip its own insert.
      //
      // NOTE: `pg_advisory_xact_lock` only serializes callers that run it on
      // the same connection as each other for the duration of their
      // transactions; `runInTransaction` uses `sql.begin()` so every query
      // below runs on the `tx` executor it hands back, guaranteeing this
      // lock call and the re-check/insert that follow all share that same
      // reserved connection.
      await runInTransaction(sql, async (tx) => {
        await tx.unsafe(
          // Reserved lock key - see MIGRATION_RECONCILE_INSERT_LOCK_KEYS's
          // doc comment: this exact (0x706c6970, 1) pair must not be reused
          // by other two-int4 pg_advisory_lock/pg_advisory_xact_lock callers.
          `SELECT pg_advisory_xact_lock(${MIGRATION_RECONCILE_INSERT_LOCK_KEYS[0]}, ${MIGRATION_RECONCILE_INSERT_LOCK_KEYS[1]})`,
        );

        const alreadyRecordedByAnotherReplica = await migrationHistoryEntryExists(
          tx,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
        );
        // If another replica inserted the row for this migration while we
        // were waiting on the lock, there is nothing left for us to do - and
        // this call did not actually perform any repair, so it must not be
        // counted in `repairedMigrations` (that would over-count "repaired"
        // migrations under concurrent replicas). It is still recorded in
        // `alreadyRecordedByOtherReplica` so callers can tell "another
        // replica already handled it, schema is fine" apart from "nothing
        // happened, still genuinely pending" - both of which would otherwise
        // collapse to the same empty `repairedMigrations` signal and cause
        // this (losing) replica to skip re-inspecting state.
        if (alreadyRecordedByAnotherReplica) {
          alreadyRecordedByOtherReplica.push(migrationFile);
          return;
        }

        // Delegate to `recordMigrationHistoryEntry` (used elsewhere for the
        // exact same insert-a-new-history-row job) rather than
        // hand-building the INSERT here, so this path gets the same
        // monotonicity guarantee: `created_at` is computed from the latest
        // row's `created_at` under the advisory lock we now hold, not from
        // the raw `folderMillis` alone. Drizzle orders applied migrations by
        // `created_at ASC`, so a non-monotonic `created_at` here would
        // produce non-deterministic ordering on next startup.
        await recordMigrationHistoryEntry(tx, qualifiedTable, columnNames, migrationFile, hash, folderMillis);
        repairedMigrations.push(migrationFile);
      });
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    alreadyRecordedByOtherReplica,
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
  const sql = createUtilitySql(url);

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

  if (initialState.reason === "no-migration-journal-empty-db") {
    const sql = createUtilitySql(url);
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let bootstrappedState = await inspectMigrations(url);
    if (bootstrappedState.status === "upToDate") return;
    if (bootstrappedState.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(url);
      if (repair.repairedMigrations.length > 0 || repair.alreadyRecordedByOtherReplica.length > 0) {
        bootstrappedState = await inspectMigrations(url);
      }
      if (bootstrappedState.status === "needsMigrations" && bootstrappedState.reason === "pending-migrations") {
        await applyPendingMigrationsManually(url, bootstrappedState.pendingMigrations);
        bootstrappedState = await inspectMigrations(url);
      }
    }
    if (bootstrappedState.status === "upToDate") return;
    throw new Error(
      `Failed to bootstrap migrations: ${bootstrappedState.pendingMigrations.join(", ")}`,
    );
  }

  if (initialState.reason === "no-migration-journal-non-empty-db") {
    throw new Error(
      "Database has tables but no migration journal; automatic migration is unsafe. Initialize migration history manually.",
    );
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0 || repair.alreadyRecordedByOtherReplica.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
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
  const sql = createUtilitySql(url);

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
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });

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

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "created";
  } finally {
    await sql.end();
  }
}

export async function resetPostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"reset"> {
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const sql = createUtilitySql(url);
  try {
    await sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await sql.unsafe(`drop database if exists ${quotedDatabaseName}`);
    await sql.unsafe(`create database ${quotedDatabaseName} encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "reset";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;
