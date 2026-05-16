// Bootstrap migration journal: compute sha256 of each migration SQL and generate INSERT statements.
// Usage: node scripts/bootstrap-migrations.js
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'db', 'src', 'migrations');

async function main() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const sqlFiles = entries
    .filter(e => e.isFile() && e.name.endsWith('.sql'))
    .map(e => e.name)
    .sort();

  console.log(`Found ${sqlFiles.length} migration files`);

  // Compute hash for each file
  const hashes = [];
  for (const file of sqlFiles) {
    const content = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    hashes.push({ file, hash });
  }

  // Generate INSERT statements with sequential timestamps
  // Start from 2025-01-01 00:00:00 UTC, increment by 1 hour per migration
  const baseTs = Date.UTC(2025, 0, 1, 0, 0, 0);
  const interval = 3600_000; // 1 hour in ms

  console.log('-- Generated INSERT statements for __drizzle_migrations');
  console.log(`-- Total: ${hashes.length} migrations\n`);

  for (let i = 0; i < hashes.length; i++) {
    const ts = baseTs + i * interval;
    console.log(`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${hashes[i].hash}', ${ts}); -- ${hashes[i].file}`);
  }

  console.log(`\n-- Total rows: ${hashes.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
