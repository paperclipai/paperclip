// Test: apply migration 0029 as a SINGLE batch string (like drizzle migrate() does)
const { resolveMigrationConnection } = require('./dist/migration-runtime.js');
const postgres = require('postgres');
const fs = require('fs');

async function test0029() {
  const resolved = await resolveMigrationConnection();
  const sql = postgres(resolved.connectionString, { max: 1, ssl: false, onnotice: () => {} });

  try {
    const content = fs.readFileSync('./dist/migrations/0029_plugin_tables.sql', 'utf8');
    const statements = content.split('--> statement-breakpoint').map(s => s.trim()).filter(s => s && !s.startsWith('--'));

    console.log(`Total stmts: ${statements.length}`);

    // Join exactly like drizzle would
    const combined = statements.join('\n');
    console.log(`Combined length: ${combined.length}`);
    console.log(`Combined (first 200): ${JSON.stringify(combined.substring(0, 200))}`);

    // Try each statement individually first
    for (let i = 0; i < statements.length; i++) {
      const s = statements[i];
      if (s.length > 2000) { console.log(`Stmt ${i}: SKIP (len=${s.length})`); continue; }
      try {
        await sql.unsafe(s);
      } catch(e) {
        console.log(`Stmt ${i} individual error: ${e.message.substring(0, 100)}`);
      }
    }

    console.log('\n--- Now trying COMBINED batch ---');

    // What drizzle actually sends: all statements joined with newline
    const drizzleBatch = statements.join('\n');

    try {
      await sql.unsafe(drizzleBatch);
      console.log('COMBINED: SUCCESS');
    } catch(e) {
      console.log(`COMBINED error at pos ${e.position}: ${e.message}`);
      // Show what's around that position
      const pos = parseInt(e.position) - 1;
      if (pos >= 0 && pos < drizzleBatch.length) {
        const start = Math.max(0, pos - 50);
        const end = Math.min(drizzleBatch.length, pos + 50);
        console.log(`Around pos ${e.position}: ${JSON.stringify(drizzleBatch.substring(start, end))}`);
        console.log(`Byte at ${e.position}: ${drizzleBatch.charCodeAt(pos)} (${drizzleBatch[pos]})`);
      }
    }
  } finally {
    await sql.end();
    await resolved.stop();
  }
}

test0029().catch(e => { console.error(e); process.exit(1); });