import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  PLUGIN_DATABASE_TRANSACTION_LIMITS,
  PLUGIN_RPC_ERROR_CODES,
  validatePluginDatabaseTransactionSql,
  type PluginDatabaseTransactionInput,
  type PluginDatabaseTransactionResult,
} from "@paperclipai/plugin-sdk/protocol";
import {
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginDatabaseCoreReadTable,
  PluginMigrationRecord,
} from "@paperclipai/shared";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_LENGTH = 63;

type SqlRef = { schema: string; table: string; keyword: string };
type RuntimeTableRef = { schema: string | null; table: string; keyword: string };
type QualifiedRefPattern =
  | { pattern: RegExp; groups: "keyword-schema-table" }
  | { pattern: RegExp; groups: "schema-table"; keyword: string };

export type PluginDatabaseRuntimeResult<T = Record<string, unknown>> = {
  rows?: T[];
  rowCount?: number;
};

/** Raised when an exact affected-row precondition aborts an atomic plugin batch. */
export class PluginDatabaseConditionFailedError extends Error {
  override readonly name = "PluginDatabaseConditionFailedError";
  readonly code = PLUGIN_RPC_ERROR_CODES.CONDITION_FAILED;
  readonly condition = "CONDITION_FAILED" as const;

  constructor(
    readonly stepIndex: number,
    readonly expectedRowCount: number,
    readonly actualRowCount: number,
  ) {
    super(
      `CONDITION_FAILED: transaction step ${stepIndex} expected rowCount `
      + `${expectedRowCount}, received ${actualRowCount}`,
    );
  }
}

export function derivePluginDatabaseNamespace(
  pluginKey: string,
  namespaceSlug?: string,
): string {
  const hash = createHash("sha256").update(pluginKey).digest("hex").slice(0, 10);
  const slug = (namespaceSlug ?? pluginKey)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 36) || "plugin";
  const namespace = `plugin_${slug}_${hash}`;
  return namespace.slice(0, MAX_POSTGRES_IDENTIFIER_LENGTH);
}

function assertIdentifier(value: string, label = "identifier"): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(`Unsafe SQL ${label}: ${value}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${assertIdentifier(value).replaceAll("\"", "\"\"")}"`;
}

function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = input.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }

  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlForKeywordScan(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function extractQualifiedRefs(statement: string): SqlRef[] {
  const refs: SqlRef[] = [];
  const patterns: QualifiedRefPattern[] = [
    {
      pattern: /\b(from|join|references|into|update)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern: /\b(alter\s+table|create\s+table|create\s+view|drop\s+table|truncate\s+table)\s+(?:if\s+(?:not\s+)?exists\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "keyword-schema-table",
    },
    {
      pattern: /\bcreate\s+(?:unique\s+)?index(?:\s+concurrently)?\s+(?:if\s+not\s+exists\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
      groups: "schema-table",
      keyword: "create index",
    },
  ];

  for (const { pattern, ...mapping } of patterns) {
    for (const match of statement.matchAll(pattern)) {
      if (mapping.groups === "keyword-schema-table") {
        refs.push({ keyword: match[1]!.toLowerCase(), schema: match[2]!, table: match[3]! });
      } else {
        refs.push({ keyword: mapping.keyword, schema: match[1]!, table: match[2]! });
      }
    }
  }
  return refs;
}

function unquoteRuntimeIdentifier(value: string): string {
  return value.startsWith("\"") && value.endsWith("\"")
    ? value.slice(1, -1).replaceAll("\"\"", "\"")
    : value;
}

/**
 * Remove runtime string contents before structural matching and fail closed on
 * comments. Comments are unnecessary for worker mutations and otherwise let a
 * comment between `FROM` and a schema evade whitespace-based table matching.
 * Double-quoted identifiers stay intact so namespace validation still sees
 * their exact structure.
 */
function maskRuntimeSqlForStructure(statement: string): string {
  let masked = "";
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    const next = statement[index + 1];

    if (singleQuoted) {
      if (char === "\\") {
        throw new Error(
          "ctx.db.execute runtime mutations must bind backslash-containing strings as parameters",
        );
      }
      masked += char === "\n" ? "\n" : " ";
      if (char === "'" && next === "'") {
        masked += " ";
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      masked += char;
      if (char === "\"" && next === "\"") {
        masked += next;
        index += 1;
      } else if (char === "\"") {
        doubleQuoted = false;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      throw new Error("ctx.db.execute runtime mutations cannot contain SQL comments");
    }
    if (char === "/" && next === "*") {
      throw new Error("ctx.db.execute runtime mutations cannot contain SQL comments");
    }
    if (
      ((char === "e" || char === "E") && next === "'")
      || ((char === "u" || char === "U") && next === "&" && statement[index + 2] === "'")
    ) {
      throw new Error(
        "ctx.db.execute runtime mutations must bind escape strings as parameters",
      );
    }
    if (char === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(statement.slice(index))) {
      throw new Error(
        "ctx.db.execute runtime mutations must bind dollar-quoted strings as parameters",
      );
    }
    if (char === "'") {
      singleQuoted = true;
      masked += " ";
      continue;
    }
    if (char === "\"") doubleQuoted = true;
    masked += char;
  }

  return masked;
}

/**
 * Runtime mutations do not support CTEs, so every table-bearing keyword can
 * be required to name a fully-qualified table. Keeping this separate from the
 * more permissive migration parser prevents an unqualified secondary table
 * from resolving through PostgreSQL's `search_path` into `public`.
 */
function extractRuntimeTableRefs(statement: string): RuntimeTableRef[] {
  const identifier = `\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_]*`;
  const refs: RuntimeTableRef[] = [];
  const addMatch = (keyword: string, first: string, second?: string) => {
    refs.push(second
      ? {
          keyword,
          schema: unquoteRuntimeIdentifier(first),
          table: unquoteRuntimeIdentifier(second),
        }
      : {
          keyword,
          schema: null,
          table: unquoteRuntimeIdentifier(first),
        });
  };

  const updateTargetPattern = new RegExp(
    `^\\s*update\\s+(?:only\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?`,
    "i",
  );
  const updateTarget = statement.match(updateTargetPattern);
  if (updateTarget) addMatch("update", updateTarget[1]!, updateTarget[2]);

  const relationPattern = new RegExp(
    `\\b(from|join|using|into|table)\\s+(?:only\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?`,
    "gi",
  );
  for (const match of statement.matchAll(relationPattern)) {
    addMatch(match[1]!.toLowerCase(), match[2]!, match[3]);
  }
  return refs;
}

function assertAllowedPublicRead(
  ref: SqlRef,
  allowedCoreReadTables: ReadonlySet<string>,
): void {
  if (ref.schema !== "public") return;
  if (!allowedCoreReadTables.has(ref.table)) {
    throw new Error(`Plugin SQL references public.${ref.table}, which is not whitelisted`);
  }
  if (!["from", "join", "references"].includes(ref.keyword)) {
    throw new Error(`Plugin SQL cannot mutate or define objects in public.${ref.table}`);
  }
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) {
    throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
  }
}

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
): void {
  assertIdentifier(namespace, "namespace");
  assertNoBannedSql(statement);

  const normalized = normaliseSql(statement);
  if (/^\s*(drop|truncate)\b/.test(normalized)) {
    throw new Error("Destructive plugin migrations are not allowed in Phase 1");
  }

  if (/\bdelete\s+from\b/.test(normalized)) {
    throw new Error("Plugin migrations cannot delete data");
  }

  const ddlOrBackfillAllowed =
    /^(create|alter|comment)\b/.test(normalized) ||
    /^(insert\s+into|update)\b/.test(normalized) ||
    (normalized.startsWith("with ") && /\b(insert\s+into|update)\b/.test(normalized));
  if (!ddlOrBackfillAllowed) {
    throw new Error("Plugin migrations may contain DDL or namespace-scoped backfill statements only");
  }

  const refs = extractQualifiedRefs(statement);
  if (refs.length === 0 && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }

  const objectRefKeywords = new Set([
    "alter table",
    "create index",
    "create table",
    "create view",
    "drop table",
    "into",
    "truncate table",
    "update",
  ]);
  const hasQualifiedObjectRef = refs.some((ref) => objectRefKeywords.has(ref.keyword));
  if (!hasQualifiedObjectRef && !normalized.startsWith("comment ")) {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }

  const allowedCoreReadTables = new Set(coreReadTables);
  for (const ref of refs) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`Plugin SQL references schema "${ref.schema}" outside namespace "${namespace}"`);
  }
}

export function validatePluginRuntimeQuery(
  query: string,
  namespace: string,
  coreReadTables: readonly PluginDatabaseCoreReadTable[] = [],
): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const normalized = normaliseSql(statement);
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("ctx.db.query only allows SELECT statements");
  }
  if (/\b(insert|update|delete|alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
  }

  const allowedCoreReadTables = new Set(coreReadTables);
  for (const ref of extractQualifiedRefs(statement)) {
    if (ref.schema === namespace) continue;
    if (ref.schema === "public") {
      assertAllowedPublicRead(ref, allowedCoreReadTables);
      continue;
    }
    throw new Error(`ctx.db.query cannot read schema "${ref.schema}"`);
  }
}

export function validatePluginRuntimeExecute(query: string, namespace: string): void {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const structuralStatement = maskRuntimeSqlForStructure(statement);
  const normalized = structuralStatement.replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain DDL keywords");
  }
  if (/\btablesample\b/.test(normalized)) {
    throw new Error("ctx.db.execute does not allow TABLESAMPLE clauses");
  }
  if (/\b(set_config|pg_sleep|pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot call timeout or advisory-lock control functions");
  }

  const identifier = `\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_]*`;
  const relationListPattern = new RegExp(
    `\\b(from|using)\\s+(?:only\\s+)?(?:${identifier})`
    + `(?:\\s*\\.\\s*(?:${identifier}))?`
    + `(?:\\s+(?:as\\s+)?(?:${identifier}))?\\s*,`,
    "i",
  );
  if (relationListPattern.test(structuralStatement) || /\b(from|using)\s*\(/i.test(
    structuralStatement,
  )) {
    throw new Error("ctx.db.execute does not allow comma or derived-table relation lists");
  }

  const refs = extractRuntimeTableRefs(structuralStatement);
  const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
  if (!target || target.schema !== namespace) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
  }
  for (const ref of refs) {
    if (ref.schema === null) {
      throw new Error(
        `ctx.db.execute table "${ref.table}" must use the fully qualified plugin namespace`,
      );
    }
    if (ref.schema !== namespace) {
      throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
    }
  }
}

function bindSql(statement: string, params: readonly unknown[] = []): SQL {
  // Safe only after callers run the plugin SQL validators above.
  if (params.length === 0) return sql.raw(statement);
  const chunks: SQL[] = [];
  let cursor = 0;
  const seen = new Set<number>();

  let quote: "'" | "\"" | null = null;
  let dollarQuote = "";
  let lineComment = false;
  let blockCommentDepth = 0;
  for (let offset = 0; offset < statement.length; offset += 1) {
    const char = statement[offset]!;
    const next = statement[offset + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockCommentDepth > 0) {
      if (char === "/" && next === "*") {
        blockCommentDepth += 1;
        offset += 1;
      } else if (char === "*" && next === "/") {
        blockCommentDepth -= 1;
        offset += 1;
      }
      continue;
    }
    if (dollarQuote) {
      if (statement.startsWith(dollarQuote, offset)) {
        offset += dollarQuote.length - 1;
        dollarQuote = "";
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          offset += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      offset += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockCommentDepth = 1;
      offset += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char !== "$") continue;

    const dollarQuoteMatch = statement.slice(offset).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (dollarQuoteMatch) {
      dollarQuote = dollarQuoteMatch[0];
      offset += dollarQuote.length - 1;
      continue;
    }

    const placeholderMatch = statement.slice(offset).match(/^\$(\d+)/);
    if (!placeholderMatch) continue;
    const parameterIndex = Number(placeholderMatch[1]);
    if (
      !Number.isInteger(parameterIndex)
      || parameterIndex < 1
      || parameterIndex > params.length
    ) {
      throw new Error(`SQL placeholder $${placeholderMatch[1]} has no matching parameter`);
    }
    chunks.push(sql.raw(statement.slice(cursor, offset)));
    chunks.push(sql`${params[parameterIndex - 1]}`);
    seen.add(parameterIndex);
    cursor = offset + placeholderMatch[0].length;
    offset = cursor - 1;
  }
  chunks.push(sql.raw(statement.slice(cursor)));
  if (seen.size !== params.length) {
    throw new Error("Every ctx.db parameter must be referenced by a $n placeholder");
  }
  return sql.join(chunks, sql.raw(""));
}

type PreparedPluginDatabaseTransactionStep = {
  statement: SQL;
  targetTable: string;
  expectRowCount?: number;
};

function runtimeMutationRowCount(result: unknown): number {
  const value = (result as { rowCount?: number | string; count?: number | string } | null);
  const count = value?.rowCount ?? value?.count ?? 0;
  const parsed = Number(count);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Plugin database driver returned an invalid row count: ${String(count)}`);
  }
  return parsed;
}

/**
 * Validate and bind the complete batch before the host opens a transaction.
 * This deliberately accepts data, not a callback, so worker code never owns a
 * live database transaction across JSON-RPC.
 */
export function preparePluginDatabaseTransaction(
  input: PluginDatabaseTransactionInput,
  namespace: string,
): PreparedPluginDatabaseTransactionStep[] {
  if (!input || typeof input !== "object" || !Array.isArray(input.steps)) {
    throw new Error("ctx.db.executeTransaction requires a steps array");
  }
  if (input.steps.length === 0) {
    throw new Error("ctx.db.executeTransaction requires at least one step");
  }
  if (input.steps.length > PLUGIN_DATABASE_TRANSACTION_LIMITS.maxSteps) {
    throw new Error(
      `ctx.db.executeTransaction accepts at most ${PLUGIN_DATABASE_TRANSACTION_LIMITS.maxSteps} steps`,
    );
  }

  let parameterCount = 0;
  for (const [index, step] of input.steps.entries()) {
    if (!step || typeof step !== "object") {
      throw new Error(`ctx.db.executeTransaction step ${index} must be an object`);
    }
    if (typeof step.sql !== "string" || step.sql.trim().length === 0) {
      throw new Error(`ctx.db.executeTransaction step ${index} SQL must be a non-empty string`);
    }
    if (step.params !== undefined && !Array.isArray(step.params)) {
      throw new Error(`ctx.db.executeTransaction step ${index} params must be an array`);
    }
    if (
      step.expectRowCount !== undefined
      && (!Number.isSafeInteger(step.expectRowCount) || step.expectRowCount < 0)
    ) {
      throw new Error(
        `ctx.db.executeTransaction step ${index} expectRowCount must be a non-negative safe integer`,
      );
    }
    parameterCount += step.params?.length ?? 0;
  }
  if (parameterCount > PLUGIN_DATABASE_TRANSACTION_LIMITS.maxParams) {
    throw new Error(
      `ctx.db.executeTransaction accepts at most ${PLUGIN_DATABASE_TRANSACTION_LIMITS.maxParams} parameters`,
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error("ctx.db.executeTransaction input must be JSON-serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_DATABASE_TRANSACTION_LIMITS.maxBytes) {
    throw new Error(
      `ctx.db.executeTransaction payload exceeds ${PLUGIN_DATABASE_TRANSACTION_LIMITS.maxBytes} bytes`,
    );
  }

  return input.steps.map((step) => {
    const target = validatePluginDatabaseTransactionSql(step.sql, namespace);
    return {
      statement: bindSql(step.sql, step.params),
      targetTable: target.table,
      ...(step.expectRowCount === undefined
        ? {}
        : { expectRowCount: step.expectRowCount }),
    };
  });
}

async function listSqlMigrationFiles(migrationsDir: string): Promise<string[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function resolveMigrationsDir(packageRoot: string, migrationsDir: string): string {
  const resolvedRoot = path.resolve(packageRoot);
  const resolvedDir = path.resolve(resolvedRoot, migrationsDir);
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Plugin migrationsDir escapes package root: ${migrationsDir}`);
  }
  return resolvedDir;
}

type PluginDatabaseClient = Pick<Db, "select" | "insert" | "update" | "execute">;
type PluginDatabaseRootClient = PluginDatabaseClient & Partial<Pick<Db, "transaction">>;

export interface ApplyPluginMigrationsOptions {
  /**
   * Persist failed migration ledger rows. Fresh install uses false because the
   * caller owns a larger transaction and must roll back the plugin row and
   * namespace together.
   */
  persistFailure?: boolean;
}

export function pluginDatabaseService(db: PluginDatabaseRootClient) {
  async function getPluginRecord(pluginId: string) {
    const rows = await db.select().from(plugins).where(eq(plugins.id, pluginId)).limit(1);
    const plugin = rows[0];
    if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);
    return plugin;
  }

  async function ensureNamespaceWithClient(
    client: PluginDatabaseClient,
    pluginId: string,
    manifest: PaperclipPluginManifestV1,
  ) {
    if (!manifest.database) return null;
    const namespaceName = derivePluginDatabaseNamespace(
      manifest.id,
      manifest.database.namespaceSlug,
    );
    await client.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(namespaceName)}`));
    const rows = await client
      .insert(pluginDatabaseNamespaces)
      .values({
        pluginId,
        pluginKey: manifest.id,
        namespaceName,
        namespaceMode: "schema",
        status: "active",
      })
      .onConflictDoUpdate({
        target: pluginDatabaseNamespaces.pluginId,
        set: {
          pluginKey: manifest.id,
          namespaceName,
          namespaceMode: "schema",
          status: "active",
          updatedAt: new Date(),
        },
      })
      .returning();
    return rows[0] ?? null;
  }

  async function ensureNamespace(pluginId: string, manifest: PaperclipPluginManifestV1) {
    return ensureNamespaceWithClient(db, pluginId, manifest);
  }

  async function getNamespace(pluginId: string) {
    const rows = await db
      .select()
      .from(pluginDatabaseNamespaces)
      .where(eq(pluginDatabaseNamespaces.pluginId, pluginId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function getRuntimeNamespace(pluginId: string) {
    const namespace = await getNamespace(pluginId);
    if (!namespace || namespace.status !== "active") {
      throw new Error("Plugin database namespace is not active");
    }
    return namespace.namespaceName;
  }

  async function recordMigrationFailure(client: PluginDatabaseClient, input: {
    pluginId: string;
    pluginKey: string;
    namespaceName: string;
    migrationKey: string;
    checksum: string;
    pluginVersion: string;
    error: unknown;
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    await client
      .insert(pluginMigrations)
      .values({
        pluginId: input.pluginId,
        pluginKey: input.pluginKey,
        namespaceName: input.namespaceName,
        migrationKey: input.migrationKey,
        checksum: input.checksum,
        pluginVersion: input.pluginVersion,
        status: "failed",
        errorMessage: message,
      })
      .onConflictDoUpdate({
        target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
        set: {
          checksum: input.checksum,
          pluginVersion: input.pluginVersion,
          status: "failed",
          errorMessage: message,
          startedAt: new Date(),
          appliedAt: null,
        },
      });
    await client
      .update(pluginDatabaseNamespaces)
      .set({ status: "migration_failed", updatedAt: new Date() })
      .where(eq(pluginDatabaseNamespaces.pluginId, input.pluginId));
  }

  return {
    ensureNamespace,

    async applyMigrations(
      pluginId: string,
      manifest: PaperclipPluginManifestV1,
      packageRoot: string,
      options: ApplyPluginMigrationsOptions = {},
    ) {
      if (!manifest.database) return null;
      const namespace = await ensureNamespace(pluginId, manifest);
      if (!namespace) return null;

      const migrationDir = resolveMigrationsDir(packageRoot, manifest.database.migrationsDir);
      const migrationFiles = await listSqlMigrationFiles(migrationDir);
      const coreReadTables = manifest.database.coreReadTables ?? [];
      const lockKey = Number.parseInt(createHash("sha256").update(pluginId).digest("hex").slice(0, 12), 16);
      const persistFailure = options.persistFailure ?? true;

      const applyWithClient = async (client: PluginDatabaseClient) => {
        await client.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
        for (const migrationKey of migrationFiles) {
          const content = await readFile(path.join(migrationDir, migrationKey), "utf8");
          const checksum = createHash("sha256").update(content).digest("hex");
          const existingRows = await client
            .select()
            .from(pluginMigrations)
            .where(and(eq(pluginMigrations.pluginId, pluginId), eq(pluginMigrations.migrationKey, migrationKey)))
            .limit(1);
          const existing = existingRows[0] as PluginMigrationRecord | undefined;
          if (existing?.status === "applied") {
            if (existing.checksum !== checksum) {
              throw new Error(`Plugin migration checksum mismatch for ${migrationKey}`);
            }
            continue;
          }

          const statements = splitSqlStatements(content);
          try {
            if (statements.length === 0) {
              throw new Error(`Plugin migration ${migrationKey} is empty`);
            }
            for (const statement of statements) {
              validatePluginMigrationStatement(statement, namespace.namespaceName, coreReadTables);
              await client.execute(sql.raw(statement));
            }
            await client
              .insert(pluginMigrations)
              .values({
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                status: "applied",
                appliedAt: new Date(),
              })
              .onConflictDoUpdate({
                target: [pluginMigrations.pluginId, pluginMigrations.migrationKey],
                set: {
                  checksum,
                  pluginVersion: manifest.version,
                  status: "applied",
                  errorMessage: null,
                  startedAt: new Date(),
                  appliedAt: new Date(),
                },
              });
          } catch (error) {
            if (persistFailure) {
              await recordMigrationFailure(db, {
                pluginId,
                pluginKey: manifest.id,
                namespaceName: namespace.namespaceName,
                migrationKey,
                checksum,
                pluginVersion: manifest.version,
                error,
              });
            }
            throw error;
          }
        }
      };

      if (typeof db.transaction === "function") {
        await db.transaction(async (tx) => applyWithClient(tx as PluginDatabaseClient));
      } else {
        await applyWithClient(db);
      }

      return namespace;
    },

    getRuntimeNamespace,

    async query<T = Record<string, unknown>>(pluginId: string, statement: string, params?: unknown[]): Promise<T[]> {
      const plugin = await getPluginRecord(pluginId);
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeQuery(statement, namespace, plugin.manifestJson.database?.coreReadTables ?? []);
      const result = await db.execute(bindSql(statement, params));
      return Array.from(result as Iterable<T>);
    },

    async execute(pluginId: string, statement: string, params?: unknown[]): Promise<{ rowCount: number }> {
      const namespace = await getRuntimeNamespace(pluginId);
      validatePluginRuntimeExecute(statement, namespace);
      const result = await db.execute(bindSql(statement, params));
      return { rowCount: runtimeMutationRowCount(result) };
    },

    async executeTransaction(
      pluginId: string,
      input: PluginDatabaseTransactionInput,
    ): Promise<PluginDatabaseTransactionResult> {
      const namespace = await getRuntimeNamespace(pluginId);
      const steps = preparePluginDatabaseTransaction(input, namespace);
      if (typeof db.transaction !== "function") {
        throw new Error("Plugin database transactions are unavailable on this database client");
      }
      for (const targetTable of new Set(steps.map((step) => step.targetTable))) {
        const relations = Array.from(
          await db.execute(sql<{ relkind: string }>`
            SELECT c.relkind
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ${namespace} AND c.relname = ${targetTable}
          `) as Iterable<{ relkind: string }>,
        );
        if (
          relations.length !== 1
          || !["r", "p"].includes(relations[0]!.relkind)
        ) {
          throw new Error(
            `ctx.db.executeTransaction target "${targetTable}" must be a plugin base table`,
          );
        }
      }

      return db.transaction(async (tx) => {
        const client = tx as PluginDatabaseClient;
        const results: PluginDatabaseTransactionResult["results"] = [];
        for (const [index, step] of steps.entries()) {
          await client.execute(sql.raw(
            `SET LOCAL search_path = pg_catalog, ${quoteIdentifier(namespace)}`,
          ));
          await client.execute(sql.raw(
            `SET LOCAL statement_timeout = '${PLUGIN_DATABASE_TRANSACTION_LIMITS.statementTimeoutMs}ms'`,
          ));
          await client.execute(sql.raw(
            `SET LOCAL lock_timeout = '${PLUGIN_DATABASE_TRANSACTION_LIMITS.statementTimeoutMs}ms'`,
          ));
          const result = await client.execute(step.statement);
          const rowCount = runtimeMutationRowCount(result);
          if (step.expectRowCount !== undefined && rowCount !== step.expectRowCount) {
            throw new PluginDatabaseConditionFailedError(
              index,
              step.expectRowCount,
              rowCount,
            );
          }
          results.push({ rowCount });
        }
        return { results };
      });
    },
  };
}
