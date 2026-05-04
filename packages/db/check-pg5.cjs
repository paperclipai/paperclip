const postgres = require('postgres');
(async () => {
  // Check as the paperclip user
  const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

  // Count available migrations
  const available = await sql`
    SELECT COUNT(*) as cnt FROM pg_tables
    WHERE schemaname = 'public'
  `;
  console.log('Total tables:', available[0]?.cnt);

  // Check drizzle schema
  const drizzleMigrations = await sql`SELECT COUNT(*) as cnt FROM drizzle.__drizzle_migrations`;
  console.log('Drizzle migration entries:', drizzleMigrations[0]?.cnt);

  // Check last migration
  const last = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 3`;
  console.log('\nLast 3 migrations:');
  for (const m of last) {
    console.log(`  id=${m.id}, hash=${m.hash?.slice(0,16)}..., created_at=${m.created_at}`);
  }

  await sql.end();
})();