import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

export type RunDatabaseBackupOptions = {
  connectionString: string;
  backupDir: string;
  retentionDays: number;
  filenamePrefix?: string;
  connectTimeoutSeconds?: number;
};

export type RunDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
  prunedCount: number;
};

export type RestoreDatabaseBackupOptions = {
  connectionString: string;
  backupFile: string;
  dropExistingSchema?: boolean;
  connectTimeoutSeconds?: number;
};

export type RestoreDatabaseBackupResult = {
  backupFile: string;
  sizeBytes: number;
};

function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function pruneOldBackups(backupDir: string, retentionDays: number, filenamePrefix: string): number {
  if (!existsSync(backupDir)) return 0;
  const safeRetention = Math.max(1, Math.trunc(retentionDays));
  const cutoff = Date.now() - safeRetention * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith(`${filenamePrefix}-`) || !name.endsWith(".sql")) continue;
    const fullPath = resolve(backupDir, name);
    const stat = statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      unlinkSync(fullPath);
      pruned++;
    }
  }

  return pruned;
}

function formatBackupSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes}B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)}K`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)}M`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function extractReferencedSequenceNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/nextval\('([^']+)'::regclass\)/g)) {
    const rawName = match[1]?.trim();
    if (!rawName) continue;

    let normalized = rawName
      .replace(/^"public"\./i, "")
      .replace(/^public\./i, "");
    if (normalized.startsWith("\"") && normalized.endsWith("\"")) {
      normalized = normalized.slice(1, -1).replace(/""/g, "\"");
    }
    if (!normalized || normalized.includes(".")) continue;
    names.add(normalized);
  }
  return Array.from(names).sort((left, right) => left.localeCompare(right));
}

function reorderDeferredStatements(content: string): string {
  const lines = content.split("\n");
  const main: string[] = [];
  const foreignKeys: string[] = [];
  const uniqueConstraints: string[] = [];
  const indexes: string[] = [];
  const tail: string[] = [];

  let section: "main" | "foreignKeys" | "uniqueConstraints" | "indexes" | "tail" = "main";
  for (const line of lines) {
    if (line === "-- Foreign keys") {
      section = "foreignKeys";
      foreignKeys.push(line);
      continue;
    }
    if (line === "-- Unique constraints") {
      section = "uniqueConstraints";
      uniqueConstraints.push(line);
      continue;
    }
    if (line === "-- Indexes") {
      section = "indexes";
      indexes.push(line);
      continue;
    }
    if (line === "-- Sequence values") {
      section = "tail";
      tail.push(line);
      continue;
    }
    if (line.startsWith("-- Data for:") && section !== "main" && section !== "tail") {
      section = "main";
    }
    if (line === "COMMIT;" && section !== "tail") {
      section = "tail";
      tail.push(line);
      continue;
    }

    switch (section) {
      case "main":
        main.push(line);
        break;
      case "foreignKeys":
        foreignKeys.push(line);
        break;
      case "uniqueConstraints":
        uniqueConstraints.push(line);
        break;
      case "indexes":
        indexes.push(line);
        break;
      case "tail":
        tail.push(line);
        break;
    }
  }

  const ordered = [...main];
  for (const block of [foreignKeys, uniqueConstraints, indexes]) {
    if (block.length === 0) continue;
    if (ordered.length > 0 && ordered[ordered.length - 1] !== "") {
      ordered.push("");
    }
    ordered.push(...block);
  }
  if (tail.length > 0) {
    if (ordered.length > 0 && ordered[ordered.length - 1] !== "") {
      ordered.push("");
    }
    ordered.push(...tail);
  }

  return ordered.join("\n");
}

function stripOuterTransaction(content: string): string {
  const lines = content.split("\n");
  let firstSqlIndex = -1;
  let lastSqlIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    firstSqlIndex = index;
    break;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;
    lastSqlIndex = index;
    break;
  }

  if (firstSqlIndex >= 0 && lines[firstSqlIndex]?.trim() === "BEGIN;") {
    lines.splice(firstSqlIndex, 1);
    if (lastSqlIndex >= firstSqlIndex) {
      lastSqlIndex -= 1;
    }
  }

  if (lastSqlIndex >= 0 && lines[lastSqlIndex]?.trim() === "COMMIT;") {
    lines.splice(lastSqlIndex, 1);
  }

  return lines.join("\n");
}

export async function runDatabaseBackup(opts: RunDatabaseBackupOptions): Promise<RunDatabaseBackupResult> {
  const filenamePrefix = opts.filenamePrefix ?? "paperclip";
  const retentionDays = Math.max(1, Math.trunc(opts.retentionDays));
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    await sql`SELECT 1`;

    const lines: string[] = [];
    const emit = (line: string) => lines.push(line);

    emit("-- Paperclip database backup");
    emit(`-- Created: ${new Date().toISOString()}`);
    emit("");
    emit("BEGIN;");
    emit("");

    // Get all enums
    const enums = await sql<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
      GROUP BY t.typname
      ORDER BY t.typname
    `;

    for (const e of enums) {
      const labels = e.labels.map((l) => `'${l.replace(/'/g, "''")}'`).join(", ");
      emit(`CREATE TYPE "public"."${e.typname}" AS ENUM (${labels});`);
    }
    if (enums.length > 0) emit("");

    const sequenceDefinitions = await sql<{
      sequencename: string;
      start_value: string;
      min_value: string;
      max_value: string;
      increment_by: string;
      cache_size: string;
      cycle: boolean;
    }[]>`
      SELECT
        sequencename,
        start_value::text,
        min_value::text,
        max_value::text,
        increment_by::text,
        cache_size::text,
        cycle
      FROM pg_sequences
      WHERE schemaname = 'public'
      ORDER BY sequencename
    `;

    if (sequenceDefinitions.length > 0) {
      emit("-- Sequences");
      for (const seq of sequenceDefinitions) {
        emit(
          `CREATE SEQUENCE IF NOT EXISTS "public".${quoteIdentifier(seq.sequencename)} START WITH ${seq.start_value} INCREMENT BY ${seq.increment_by} MINVALUE ${seq.min_value} MAXVALUE ${seq.max_value} CACHE ${seq.cache_size} ${seq.cycle ? "CYCLE" : "NO CYCLE"};`,
        );
      }
      emit("");
    }

    // Get tables in dependency order (referenced tables first)
    const tables = await sql<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname != '__drizzle_migrations'
      ORDER BY c.relname
    `;

    // Get full CREATE TABLE DDL via column info
    for (const { tablename } of tables) {
      const columns = await sql<{
        column_name: string;
        data_type: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        character_maximum_length: number | null;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]>`
        SELECT column_name, data_type, udt_name, is_nullable, column_default,
               character_maximum_length, numeric_precision, numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;

      emit(`-- Table: ${tablename}`);
      emit(`DROP TABLE IF EXISTS "${tablename}" CASCADE;`);

      const colDefs: string[] = [];
      for (const col of columns) {
        let typeStr: string;
        if (col.data_type === "USER-DEFINED") {
          typeStr = `"${col.udt_name}"`;
        } else if (col.data_type === "ARRAY") {
          typeStr = `${col.udt_name.replace(/^_/, "")}[]`;
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
        WHERE n.nspname = 'public' AND t.relname = ${tablename} AND c.contype = 'p'
        GROUP BY c.conname
      `;
      for (const p of pk) {
        const cols = p.column_names.map((c) => `"${c}"`).join(", ");
        colDefs.push(`  CONSTRAINT "${p.constraint_name}" PRIMARY KEY (${cols})`);
      }

      emit(`CREATE TABLE "${tablename}" (`);
      emit(colDefs.join(",\n"));
      emit(");");
      emit("");
    }

    // Foreign keys (after all tables created)
    const fks = await sql<{
      constraint_name: string;
      source_table: string;
      source_columns: string[];
      target_table: string;
      target_columns: string[];
      update_rule: string;
      delete_rule: string;
    }[]>`
      SELECT
        c.conname AS constraint_name,
        src.relname AS source_table,
        array_agg(sa.attname ORDER BY array_position(c.conkey, sa.attnum)) AS source_columns,
        tgt.relname AS target_table,
        array_agg(ta.attname ORDER BY array_position(c.confkey, ta.attnum)) AS target_columns,
        CASE c.confupdtype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS update_rule,
        CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS delete_rule
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_class tgt ON tgt.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = ANY(c.conkey)
      JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = ANY(c.confkey)
      WHERE c.contype = 'f' AND n.nspname = 'public'
      GROUP BY c.conname, src.relname, tgt.relname, c.confupdtype, c.confdeltype
      ORDER BY src.relname, c.conname
    `;

    const foreignKeyLines: string[] = [];
    if (fks.length > 0) {
      foreignKeyLines.push("-- Foreign keys");
      for (const fk of fks) {
        const srcCols = fk.source_columns.map((c) => `"${c}"`).join(", ");
        const tgtCols = fk.target_columns.map((c) => `"${c}"`).join(", ");
        foreignKeyLines.push(
          `ALTER TABLE "${fk.source_table}" ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY (${srcCols}) REFERENCES "${fk.target_table}" (${tgtCols}) ON UPDATE ${fk.update_rule} ON DELETE ${fk.delete_rule};`,
        );
      }
      foreignKeyLines.push("");
    }

    // Unique constraints
    const uniques = await sql<{
      constraint_name: string;
      tablename: string;
      column_names: string[];
    }[]>`
      SELECT c.conname AS constraint_name,
             t.relname AS tablename,
             array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum)) AS column_names
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
      WHERE n.nspname = 'public' AND c.contype = 'u'
      GROUP BY c.conname, t.relname
      ORDER BY t.relname, c.conname
    `;

    const uniqueConstraintLines: string[] = [];
    if (uniques.length > 0) {
      uniqueConstraintLines.push("-- Unique constraints");
      for (const u of uniques) {
        const cols = u.column_names.map((c) => `"${c}"`).join(", ");
        uniqueConstraintLines.push(`ALTER TABLE "${u.tablename}" ADD CONSTRAINT "${u.constraint_name}" UNIQUE (${cols});`);
      }
      uniqueConstraintLines.push("");
    }

    // Indexes (non-primary, non-unique-constraint)
    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname NOT IN (
          SELECT conname FROM pg_constraint
          WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        )
      ORDER BY tablename, indexname
    `;

    const indexLines: string[] = [];
    if (indexes.length > 0) {
      indexLines.push("-- Indexes");
      for (const idx of indexes) {
        indexLines.push(`${idx.indexdef};`);
      }
      indexLines.push("");
    }

    // Dump data for each table
    for (const { tablename } of tables) {
      const count = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(tablename)}
      `;
      if ((count[0]?.n ?? 0) === 0) continue;

      // Get column info for this table
      const cols = await sql<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${tablename}
        ORDER BY ordinal_position
      `;
      const colNames = cols.map((c) => `"${c.column_name}"`).join(", ");

      emit(`-- Data for: ${tablename} (${count[0]!.n} rows)`);

      const rows = await sql`SELECT * FROM ${sql(tablename)}`.values();
      for (const row of rows) {
        const values = row.map((val: unknown) => {
          if (val === null || val === undefined) return "NULL";
          if (typeof val === "boolean") return val ? "true" : "false";
          if (typeof val === "number") return String(val);
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        emit(`INSERT INTO "${tablename}" (${colNames}) VALUES (${values.join(", ")});`);
      }
      emit("");
    }

    for (const line of foreignKeyLines) emit(line);
    for (const line of uniqueConstraintLines) emit(line);
    for (const line of indexLines) emit(line);

    // Sequence values
    const sequenceValues = await sql<{ sequence_name: string }[]>`
      SELECT sequence_name
      FROM information_schema.sequences
      WHERE sequence_schema = 'public'
      ORDER BY sequence_name
    `;

    if (sequenceValues.length > 0) {
      emit("-- Sequence values");
      for (const seq of sequenceValues) {
        const val = await sql<{ last_value: string }[]>`
          SELECT last_value::text FROM ${sql(seq.sequence_name)}
        `;
        if (val[0]) {
          emit(`SELECT setval('"${seq.sequence_name}"', ${val[0].last_value});`);
        }
      }
      emit("");
    }

    emit("COMMIT;");
    emit("");

    // Write the backup file
    mkdirSync(opts.backupDir, { recursive: true });
    const backupFile = resolve(opts.backupDir, `${filenamePrefix}-${timestamp()}.sql`);
    await writeFile(backupFile, lines.join("\n"), "utf8");

    const sizeBytes = statSync(backupFile).size;
    const prunedCount = pruneOldBackups(opts.backupDir, retentionDays, filenamePrefix);

    return {
      backupFile,
      sizeBytes,
      prunedCount,
    };
  } finally {
    await sql.end();
  }
}

export async function restoreDatabaseBackup(
  opts: RestoreDatabaseBackupOptions,
): Promise<RestoreDatabaseBackupResult> {
  const connectTimeout = Math.max(1, Math.trunc(opts.connectTimeoutSeconds ?? 5));
  const sql = postgres(opts.connectionString, { max: 1, connect_timeout: connectTimeout });

  try {
    const content = await readFile(opts.backupFile, "utf8");
    const sizeBytes = Buffer.byteLength(content, "utf8");
    const restoreSql = stripOuterTransaction(reorderDeferredStatements(content));

    await sql`SELECT 1`;
    await sql.begin(async (tx) => {
      if (opts.dropExistingSchema !== false) {
        await tx.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
      }
      for (const sequenceName of extractReferencedSequenceNames(content)) {
        await tx.unsafe(`CREATE SEQUENCE IF NOT EXISTS "public".${quoteIdentifier(sequenceName)};`);
      }
      await tx.unsafe(restoreSql);
    });

    return {
      backupFile: opts.backupFile,
      sizeBytes,
    };
  } finally {
    await sql.end();
  }
}

export function formatDatabaseBackupResult(result: RunDatabaseBackupResult): string {
  const size = formatBackupSize(result.sizeBytes);
  const pruned = result.prunedCount > 0 ? `; pruned ${result.prunedCount} old backup(s)` : "";
  return `${result.backupFile} (${size}${pruned})`;
}
