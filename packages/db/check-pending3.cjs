// Check which of the 66 journal files are missing from the DB
const postgres = require('postgres');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

async function main() {
  // Get all hashes from drizzle table
  const dbRows = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`;
  const dbHashes = new Set(dbRows.map(r => r.hash));

  // Read JOURNAL (not file list)
  const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
  const entries = (journal.entries || []);

  console.log(`Journal entries: ${entries.length}`);

  // Check each journal entry against DB
  const pending = [];
  for (const entry of entries) {
    const filePath = path.join('./dist/migrations', `${entry.tag}.sql`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const existsInDb = dbHashes.has(hash);
      if (!existsInDb) {
        pending.push({ tag: entry.tag, hash, when: entry.when });
      }
    }
  }

  console.log(`Pending (not in DB): ${pending.length}`);
  for (const p of pending) {
    console.log(`  ${p.tag}: hash=${p.hash.slice(0,16)}..., when=${p.when}`);
  }

  // Now check: which ones ARE in the DB but with different hash?
  // (file was modified after being applied)
  const matching = [];
  for (const entry of entries) {
    const filePath = path.join('./dist/migrations', `${entry.tag}.sql`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const dbEntry = dbRows.find(r => r.hash === hash);
      if (dbEntry) {
        matching.push({ tag: entry.tag, dbCreatedAt: dbEntry.created_at, fileWhen: entry.when });
      }
    }
  }
  console.log(`\nMatching in DB: ${matching.length}`);

  await sql.end();
}

main().catch(e => console.error(e));