// Instrumented migration runner - intercepts each statement and logs position
import { resolveMigrationConnection } from './dist/migration-runtime.js';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_FOLDER = new URL('./dist/migrations', import.meta.url);
const DRIZZLE_MIGRATIONS_TABLE = '__drizzle_migrations';

const delimiter = '--> statement-breakpoint';

function splitMigrationStatements(content: string): string[] {
  return content
    .split(delimiter)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main() {
  const resolved = await resolveMigrationConnection();
  console.log('Connection:', resolved.connectionString);

  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  // Create schema and migration table
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS drizzle');
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS drizzle.${DRIZZLE_MIGRATIONS_TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`
  );

  // Read journal
  const journalPath = path.join(MIGRATIONS_FOLDER.pathname, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const entries = (journal.entries || []).filter(e => typeof e?.tag === 'string' && typeof e?.when === 'number');

  // Get last migration from DB
  const lastRow = await sql.unsafe<{ created_at: number | null }[]>(
    `SELECT created_at FROM drizzle.${DRIZZLE_MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`
  );
  const lastDbMigration = lastRow[0];

  console.log(`\nJournal entries: ${entries.length}`);
  console.log(`Last DB migration: ${lastDbMigration?.created_at ?? 'none'}`);

  // Build cumulative byte positions
  const allContent: string[] = [];
  const boundaries: { entryIdx: number; start: number; tag: string }[] = [];

  for (const entry of entries) {
    const filePath = path.join(MIGRATIONS_FOLDER.pathname, `${entry.tag}.sql`);
    const content = await readFile(filePath, 'utf8');
    boundaries.push({ entryIdx: entries.indexOf(entry), start: allContent.length, tag: entry.tag });
    allContent.push(content);
  }

  const fullContent = allContent.join('');

  // Drizzle-style split (no trim, no filter)
  const allStatements = fullContent.split(delimiter);
  console.log(`Total statements: ${allStatements.length}`);
  console.log(`Total bytes: ${fullContent.length}`);

  // Find cumulative position of each statement start
  let cumulativePos = 0;
  const stmtPositions: { index: number; start: number; content: string }[] = [];
  for (const stmt of allStatements) {
    stmtPositions.push({ index: stmtPositions.length, start: cumulativePos, content: stmt });
    cumulativePos += stmt.length + delimiter.length;
  }

  // Apply statements one by one, tracking cumulative byte position
  let globalByteOffset = 0;
  let errorsShown = 0;

  for (const stmt of allStatements) {
    if (stmt.trim().length === 0) {
      globalByteOffset += stmt.length + delimiter.length;
      continue;
    }

    const stmtStart = globalByteOffset;
    const stmtEnd = globalByteOffset + stmt.length;

    // Report progress every 10 statements
    if (stmtPositions.length <= 50 || stmtPositions.indexOf(stmtPositions.find(s => s.start === stmtStart)!)! % 50 === 0) {
      console.log(`Stmt ${stmtPositions.indexOf(stmtPositions.find(s => s.start === stmtStart)!)}: bytes ${stmtStart}-${stmtEnd}, "${stmt.substring(0, 40).replace(/\r?\n/g, '\\n')}..."`);
    }

    try {
      await sql.unsafe(stmt);
    } catch (e: any) {
      const errPos = parseInt(e.position) - 1; // 0-indexed

      // Find which statement contains this error position
      let culpritIdx = -1;
      let culpritStart = -1;
      let culpritContent = '';
      for (const sp of stmtPositions) {
        if (sp.start <= errPos && errPos < sp.start + sp.content.length) {
          culpritIdx = sp.index;
          culpritStart = sp.start;
          culpritContent = sp.content;
          break;
        }
      }

      console.log(`\n=== ERROR at Postgres position ${e.position} (0-indexed: ${errPos}) ===`);
      console.log(`Cumulative byte range of statement ${culpritIdx}: ${culpritStart}-${culpritStart + culpritContent.length}`);
      console.log(`This statement's own start offset: ${errPos - culpritStart}`);
      console.log(`Error: ${e.message}`);
      console.log(`\nCulprit statement ${culpritIdx} (${culpritContent.length} chars):`);
      console.log(culpritContent);
      console.log(`\n=== END ERROR ===\n`);

      errorsShown++;
      if (errorsShown >= 1) break; // Stop after first error
    }

    globalByteOffset += stmt.length + delimiter.length;
  }

  if (errorsShown === 0) {
    console.log('\nAll statements applied successfully!');
  }

  await sql.end();
  await resolved.stop();
}

main().catch(e => { console.error(e); process.exit(1); });