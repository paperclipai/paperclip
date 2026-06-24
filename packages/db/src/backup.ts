import postgres from "postgres";
import { createHash } from "node:crypto";
import { readFile, mkdir, readdir, copyFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

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



    // Fallback: generate CREATE TABLE from information_schema
    for (const table of tables) {
      dump += `-- Table: ${table.tablename}\n`;
      const columns = await sql<{ column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, data_type, udt_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table.tablename}
        ORDER BY ordinal_position
      `;

      dump += `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.tablename)} (\n`;
      const colDefs = columns.map((col) => {
        let typeStr = col.data_type.toUpperCase();
        if (typeStr === "ARRAY") {
          typeStr = col.udt_name.replace(/^_/, "") + "[]";
        } else if (typeStr === "USER-DEFINED") {
          typeStr = col.udt_name;
        }
        
        let def = `  ${quoteIdentifier(col.column_name)} ${typeStr}`;
        if (col.column_default) def += ` DEFAULT ${col.column_default}`;
        if (col.is_nullable === "NO") def += " NOT NULL";
        return def;
      });
      dump += colDefs.join(",\n");
      dump += "\n);\n\n";

      // Dump data
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

export async function restoreDatabase(url: string, backupPath: string): Promise<void> {
  const content = await readFile(backupPath, "utf8");
  const statements = content
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/);

  const sql = postgres(url, { max: 1 });
  try {
    // Drop existing tables first
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `;
    for (const table of tables) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(table.tablename)} CASCADE`);
    }

    // Execute backup statements
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed) {
        await sql.unsafe(trimmed);
      }
    }

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
