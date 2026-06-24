import postgres from "postgres";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPendingMigrations } from "./client.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = join(__dirname, "..", "..", "data", "backups");

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

async function ensureBackupDir(): Promise<void> {
  await mkdir(BACKUPS_DIR, { recursive: true });
}

function generateBackupFilename(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `backup-${timestamp}.sql`;
}

export async function backupDatabase(url: string): Promise<string> {
  await ensureBackupDir();

  const sql = postgres(url, { max: 1 });
  try {
    // Get all public tables
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;

    if (tables.length === 0) {
      console.log("No tables found in public schema. Nothing to backup.");
      return "";
    }

    let dump = "-- Paperclip Database Backup\n";
    dump += `-- Generated: ${new Date().toISOString()}\n\n`;

    // We no longer dump schema (CREATE TABLE). We rely on Drizzle migrations 
    // during restore to produce a structurally perfect database.
    for (const table of tables) {
      const rows = await sql.unsafe(`SELECT * FROM ${quoteIdentifier(table.tablename)}`);
      if (rows.length > 0) {
        dump += `-- Data: ${table.tablename} (${rows.length} rows)\n`;
        for (const row of rows) {
          const keys = Object.keys(row);
          const values = keys.map((k) => {
            const v = row[k];
            if (v === null || v === undefined) return "NULL";
            if (typeof v === "number") return String(v);
            if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
            if (Array.isArray(v)) {
              const pgArray = "{" + v.map(item => {
                if (item === null) return "NULL";
                return `"${String(item).replaceAll('"', '\\"')}"`;
              }).join(",") + "}";
              return `'${pgArray.replaceAll("'", "''")}'`;
            }
            if (v instanceof Date) return `'${v.toISOString()}'`;
            if (typeof v === "object") return `'${JSON.stringify(v).replaceAll("'", "''")}'`;
            return `'${String(v).replaceAll("'", "''")}'`;
          });
          dump += `INSERT INTO ${quoteIdentifier(table.tablename)} (${keys.map(quoteIdentifier).join(", ")}) VALUES (${values.join(", ")});\n`;
        }
        dump += "\n";
      }
    }

    // Save to file
    const filename = generateBackupFilename();
    const filePath = join(BACKUPS_DIR, filename);
    await writeFile(filePath, dump);

    console.log(`Backup saved to ${filePath} (${tables.length} tables)`);
    return filePath;
  } finally {
    await sql.end();
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  const { writeFile: fsWriteFile } = await import("node:fs/promises");
  await fsWriteFile(path, content, "utf8");
}

export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inComment = false;
  
  for (let i = 0; i < sqlText.length; i++) {
    const char = sqlText[i];
    
    if (inComment) {
      if (char === "\n") {
        inComment = false;
      }
      continue;
    }
    
    if (!inString && char === "-" && sqlText[i + 1] === "-") {
      inComment = true;
      i++;
      continue;
    }

    if (char === "'") {
      // Handle escaped quotes
      if (sqlText[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inString = !inString;
    }
    if (char === ";" && !inString) {
      if (current.trim()) statements.push(current.trim() + ";");
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function restoreDatabase(url: string, backupPath: string): Promise<void> {
  const content = await readFile(backupPath, "utf8");
  const statements = splitSqlStatements(content);

  console.log("Taking safety snapshot of current database state...");
  try {
    const snapshotPath = await backupDatabase(url);
    if (snapshotPath) {
      console.log(`Safety snapshot created at ${snapshotPath} before restore.`);
    }
  } catch (e) {
    console.warn("Warning: Failed to take safety snapshot. Proceeding with restore anyway.", e);
  }

  const sql = postgres(url, { max: 1 });
  try {
    // Drop existing schemas
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE;");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE;");
    await sql.unsafe("CREATE SCHEMA public;");

    // Re-apply migrations to get perfect schema (sequences, constraints, indexes)
    await applyPendingMigrations(url);

    // Execute backup data statements
    await sql.begin(async (tx) => {
      for (const statement of statements) {
        const trimmed = statement.trim();
        if (trimmed) {
          await tx.unsafe(trimmed);
        }
      }

      // Sync sequences
      const sequences = await tx<{ sequence_name: string; table_name: string; column_name: string }[]>`
        SELECT
            s.relname AS sequence_name,
            t.relname AS table_name,
            a.attname AS column_name
        FROM pg_class s
        JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
        JOIN pg_class t ON t.oid = d.refobjid
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'
      `;

      for (const seq of sequences) {
        const escapedSeqName = seq.sequence_name.replace(/'/g, "''");
        await tx.unsafe(`SELECT setval('${escapedSeqName}', COALESCE((SELECT MAX(${quoteIdentifier(seq.column_name)}) FROM ${quoteIdentifier(seq.table_name)}), 1), true)`);
      }
    });

    console.log(`Database restored from ${backupPath}`);
  } finally {
    await sql.end();
  }
}

export async function listBackups(): Promise<string[]> {
  try {
    const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => join(BACKUPS_DIR, e.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
