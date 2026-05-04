// Debug ALL migrations one by one
const { resolveMigrationConnection } = require('./dist/migration-runtime.js');
const postgres = require('postgres');
const fs = require('fs');
const path = require('path');

const delimiter = '--> statement-breakpoint';
const migrationsDir = './dist/migrations';

async function debugAllMigrations() {
  const resolved = await resolveMigrationConnection();
  console.log('Connection:', resolved.connectionString);

  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  try {
    // Read journal to get ordered files
    const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
    const orderedFiles = (journal.entries || []).map(e => `${e.tag}.sql`).filter(f => fs.existsSync(path.join(migrationsDir, f)));
    console.log('Found', orderedFiles.length, 'migration files');

    let totalStmts = 0;
    let fileIdx = 0;
    for (const file of orderedFiles) {
      fileIdx++;
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);
      console.log(`\n[${fileIdx}/${orderedFiles.length}] ${file}: ${parts.length} statements`);

      for (let i = 0; i < parts.length; i++) {
        const stmt = parts[i];
        totalStmts++;
        const stmtId = totalStmts;

        if (stmt.length > 2000) {
          console.log(`  Stmt ${stmtId} (${file}#${i}): SKIP (len=${stmt.length})`);
          continue;
        }

        try {
          await sql.unsafe(stmt);
        } catch (e) {
          console.log(`  Stmt ${stmtId} (${file}#${i}): ERROR at pos ${e.position}: ${e.message}`);
          const pos = parseInt(e.position) - 1;
          if (pos >= 0 && pos < stmt.length) {
            console.log(`  Char at ${e.position}: ${JSON.stringify(stmt.substring(pos, pos + 30))}`);
          }
          console.log(`  Full:\n${stmt}`);
          console.log(`\n=== FAILURE in ${file}, statement ${i} (total stmt #${stmtId}) ===`);
          process.exit(1);
        }
      }
    }
    console.log(`\nALL ${totalStmts} statements applied successfully!`);
  } finally {
    await sql.end();
    await resolved.stop();
  }
}

debugAllMigrations().catch(e => { console.error(e); process.exit(1); });