// Start embedded postgres and apply migrations one by one to find the failing statement
import { resolveMigrationConnection } from './packages/db/src/migration-runtime.js';
import { splitMigrationStatements } from './packages/db/src/client.js';
import { readFileSync } from 'node:fs';

async function main() {
  const resolved = await resolveMigrationConnection();
  console.log('Connected to', resolved.source);

  const sql = resolved.connectionString;
  const postgres = (await import('postgres')).default;
  const client = postgres(sql, { max: 1, ssl: false, connect_timeout: 30 });

  try {
    // List migration files in order from journal
    const journalPath = './packages/db/src/migrations/meta/_journal.json';
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    const files = (journal.entries || []).map(e => `${e.tag}.sql`);

    console.log(`Total migrations in journal: ${files.length}`);

    for (const file of files.slice(0, 10)) { // First 10 only
      const filePath = `./packages/db/src/migrations/${file}`;
      const content = readFileSync(filePath, 'utf8');
      const statements = splitMigrationStatements(content);
      console.log(`\n=== ${file}: ${statements.length} statements ===`);

      for (let i = 0; i < Math.min(statements.length, 5); i++) {
        const stmt = statements[i];
        if (stmt.length > 1500) {
          console.log(`  Stmt ${i}: ${stmt.length} chars (LONG - skipping)`);
          continue;
        }
        try {
          await client.unsafe(stmt);
          console.log(`  Stmt ${i}: OK (${stmt.length} chars)`);
        } catch (e) {
          console.log(`  Stmt ${i}: ERROR at pos ${e.position}: ${e.message}`);
          // Show the actual bytes around the error position
          const pos = parseInt(e.position) - 1;
          const ctx = stmt.substring(Math.max(0, pos - 30), pos + 50);
          console.log(`  Context: "${ctx}"`);
        }
      }
    }
  } finally {
    await client.end();
    await resolved.stop();
  }
}

main().catch(console.error);