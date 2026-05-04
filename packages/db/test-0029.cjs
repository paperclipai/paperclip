// Test applying migration 0029 as a SINGLE batch (like drizzle)
const { resolveMigrationConnection } = require('./dist/migration-runtime.js');
const postgres = require('postgres');
const fs = require('fs');

const delimiter = '--> statement-breakpoint';

async function test0029() {
  const resolved = await resolveMigrationConnection();
  console.log('Connection:', resolved.connectionString);

  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  try {
    // Read and apply 0029 as drizzle would - in one go
    const content = fs.readFileSync('./dist/migrations/0029_plugin_tables.sql', 'utf8');
    const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);
    console.log(`0029 has ${parts.length} statements`);

    for (let i = 0; i < parts.length; i++) {
      const stmt = parts[i];
      console.log(`Stmt ${i}: len=${stmt.length} first60=${JSON.stringify(stmt.substring(0, 60))}`);

      if (stmt.length > 2000) {
        console.log('  SKIP (too long)');
        continue;
      }

      try {
        await sql.unsafe(stmt);
        console.log('  OK');
      } catch (e) {
        console.log(`  ERROR at pos ${e.position}: ${e.message}`);
        const pos = parseInt(e.position) - 1;
        if (pos >= 0 && pos < stmt.length) {
          console.log(`  Char at ${e.position}: ${JSON.stringify(stmt.substring(pos, pos + 30))}`);
        }
        console.log(`  Full:\n${stmt}`);
        break;
      }
    }
  } finally {
    await sql.end();
    await resolved.stop();
  }
}

test0029().catch(e => { console.error(e); process.exit(1); });