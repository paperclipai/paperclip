// Check what 7 pending migrations are
const postgres = require('postgres');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

async function main() {
  // Get applied migration names from drizzle table
  const applied = await sql`SELECT name, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
  console.log('Drizzle migration entries:', applied.length);

  // Read journal
  const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
  const entries = (journal.entries || []);

  // Find applied hashes
  const appliedHashes = new Set(applied.map(a => a.hash));

  // Find missing entries (in journal but not in drizzle table)
  const missing = [];
  for (const entry of entries) {
    const filePath = path.join('./dist/migrations', `${entry.tag}.sql`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      if (!appliedHashes.has(hash)) {
        missing.push({ tag: entry.tag, hash, when: entry.when, file: filePath });
      }
    }
  }

  console.log(`\nMissing from drizzle table: ${missing.length}`);
  for (const m of missing) {
    console.log(`  ${m.tag}: hash=${m.hash.slice(0,16)}..., when=${m.when}`);
  }

  // Also check the LAST applied migration to understand the ordering
  if (applied.length > 0) {
    const lastApplied = applied[applied.length - 1];
    console.log(`\nLast applied: ${lastApplied.name} (${lastApplied.hash.slice(0,16)}...) created_at=${lastApplied.created_at}`);
  }

  await sql.end();
}

main().catch(e => console.error(e));