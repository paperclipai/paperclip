// Check each statement's length - find which one is >= 1824 chars long
// because that's the only way position 1824 can appear in a single statement
import { resolveMigrationConnection } from './dist/migration-runtime.js';
import postgres from 'postgres';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS_FOLDER = new URL('./dist/migrations', import.meta.url);
const delimiter = '--> statement-breakpoint';

async function main() {
  const resolved = await resolveMigrationConnection();
  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  // Read journal and ALL files
  const journalPath = path.join(MIGRATIONS_FOLDER.pathname, 'meta/_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const entries = (journal.entries || []).filter(e => typeof e?.tag === 'string');

  let allContent = '';
  for (const entry of entries) {
    const filePath = path.join(MIGRATIONS_FOLDER.pathname, `${entry.tag}.sql`);
    const content = await readFile(filePath, 'utf8');
    allContent += content;
  }

  const statements = allContent.split(delimiter);
  console.log(`Total statements: ${statements.length}`);

  // Find statements >= 1824 chars (since position 1824 must be INSIDE such a statement)
  const largeStmts: { index: number; length: number; preview: string }[] = [];
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i].trim();
    if (s.length >= 1824) {
      largeStmts.push({ index: i, length: s.length, preview: s.substring(0, 100) });
    }
  }

  console.log(`\nStatements with length >= 1824: ${largeStmts.length}`);
  for (const ls of largeStmts) {
    console.log(`  Stmt ${ls.index}: len=${ls.length}, preview=${JSON.stringify(ls.preview)}`);
  }

  // Now try each large statement to find the culprit
  console.log('\n--- Testing large statements individually ---');
  for (const ls of largeStmts) {
    const stmt = statements[ls.index];
    try {
      await sql.unsafe(stmt);
      console.log(`Stmt ${ls.index}: OK (${stmt.length} chars)`);
    } catch (e: any) {
      console.log(`Stmt ${ls.index}: ERROR at pos ${e.position}: ${e.message}`);
      console.log(`Statement preview: ${JSON.stringify(stmt.substring(0, 200))}`);
      // Show what's near the error position
      const pos = parseInt(e.position) - 1;
      if (pos >= 0 && pos < stmt.length) {
        const start = Math.max(0, pos - 50);
        const end = Math.min(stmt.length, pos + 50);
        console.log(`Near pos ${e.position}: ${JSON.stringify(stmt.substring(start, end))}`);
      }
      break; // Found the culprit
    }
  }

  await sql.end();
  await resolved.stop();
}

main().catch(e => { console.error(e); process.exit(1); });