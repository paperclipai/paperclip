// Start fresh embedded postgres and try applying migration 0000 statements
import postgres from 'postgres';
import { resolveMigrationConnection } from './packages/db/src/migration-runtime.js';
import { readFileSync } from 'node:fs';

const MIGRATIONS_FOLDER = './packages/db/src/migrations';
const delimiter = '--> statement-breakpoint';

async function testMigration0() {
  console.log('Starting embedded postgres...');
  const resolved = await resolveMigrationConnection();
  console.log(`Connected: ${resolved.source}`);

  const client = postgres(resolved.connectionString, { max: 1, ssl: false });

  try {
    // Read 0000 file
    const content = readFileSync(`${MIGRATIONS_FOLDER}/0000_mature_masked_marvel.sql`, 'utf8');
    const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

    console.log(`\n0000 has ${parts.length} statements`);

    for (let i = 0; i < parts.length; i++) {
      const stmt = parts[i];
      console.log(`\nStmt ${i}: len=${stmt.length}, first 60 chars: ${JSON.stringify(stmt.substring(0, 60))}`);

      if (stmt.length > 2000) {
        console.log('  (skipping long statement)');
        continue;
      }

      try {
        await client.unsafe(stmt);
        console.log(`  -> OK`);
      } catch (e) {
        console.log(`  -> ERROR at pos ${e.position}: ${e.message}`);
        const pos = parseInt(e.position) - 1;
        console.log(`     Char at ${e.position}: ${JSON.stringify(stmt.substring(pos, pos+30))}`);
        console.log(`     Full statement:\n${stmt}`);
        break;
      }
    }
  } finally {
    await client.end();
    await resolved.stop();
  }
}

testMigration0().catch(console.error);