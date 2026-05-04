// Check each statement's length - find which one is >= 1824 chars long
const { resolveMigrationConnection } = require('./dist/migration-runtime.js');
const postgres = require('postgres');
const fs = require('fs');
const path = require('path');

const migrationsDir = './dist/migrations';
const delimiter = '--> statement-breakpoint';

async function main() {
  const resolved = await resolveMigrationConnection();
  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  // Read journal
  const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
  const entries = (journal.entries || []).filter(e => typeof e?.tag === 'string');

  // Concatenate all files
  let allContent = '';
  for (const entry of entries) {
    const filePath = path.join(migrationsDir, `${entry.tag}.sql`);
    allContent += fs.readFileSync(filePath, 'utf8');
  }

  const statements = allContent.split(delimiter);
  console.log(`Total statements: ${statements.length}`);
  console.log(`Total content: ${allContent.length} chars`);

  // Find statements >= 1824 chars
  const largeStmts = [];
  for (let i = 0; i < statements.length; i++) {
    const s = statements[i].trim();
    if (s.length >= 1824) {
      largeStmts.push({ index: i, length: s.length, preview: s.substring(0, 80) });
    }
  }

  console.log(`\nStatements with length >= 1824: ${largeStmts.length}`);
  for (const ls of largeStmts) {
    console.log(`  Stmt ${ls.index}: len=${ls.length}`);
    console.log(`    Preview: ${JSON.stringify(ls.preview)}`);
  }

  // Test each large statement individually
  console.log('\n--- Testing large statements ---');
  for (const ls of largeStmts) {
    const stmt = statements[ls.index];
    try {
      await sql.unsafe(stmt);
      console.log(`Stmt ${ls.index}: OK`);
    } catch (e) {
      console.log(`Stmt ${ls.index}: ERROR at pos ${e.position}: ${e.message}`);
      const pos = parseInt(e.position) - 1;
      if (pos >= 0 && pos < stmt.length) {
        const start = Math.max(0, pos - 40);
        const end = Math.min(stmt.length, pos + 40);
        console.log(`Near error: ${JSON.stringify(stmt.substring(start, end))}`);
      }
      break;
    }
  }

  await sql.end();
  await resolved.stop();
}

main().catch(e => { console.error(e); process.exit(1); });