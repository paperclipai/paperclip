// Find which 7 migrations are pending (hash mismatch)
const postgres = require('postgres');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

async function main() {
  // Get all hashes from drizzle table
  const dbRows = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
  const dbHashes = new Set(dbRows.map(r => r.hash));
  const dbByHash = new Map(dbRows.map(r => [r.hash, r]));

  console.log(`DB has ${dbHashes.size} unique hashes`);

  // Read journal
  const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
  const entries = (journal.entries || []);

  // Check each journal entry
  const pending = [];
  for (const entry of entries) {
    const filePath = path.join('./dist/migrations', `${entry.tag}.sql`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const exists = dbHashes.has(hash);
      if (!exists) {
        pending.push({ tag: entry.tag, hash, when: entry.when, file: filePath });
      }
    }
  }

  console.log(`\nPending (hash not in DB): ${pending.length}`);
  for (const p of pending) {
    console.log(`  ${p.tag}: hash=${p.hash.slice(0,16)}..., when=${p.when}`);
  }

  // Also check: are there entries IN DB but NOT in journal?
  // (This would confirm modified files)
  const journalHashes = new Set();
  for (const entry of entries) {
    const filePath = path.join('./dist/migrations', `${entry.tag}.sql`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      journalHashes.add(hash);
    }
  }

  const extraInDb = dbRows.filter(r => !journalHashes.has(r.hash));
  console.log(`\nExtra in DB (not in journal): ${extraInDb.length}`);

  await sql.end();
}

main().catch(e => console.error(e));