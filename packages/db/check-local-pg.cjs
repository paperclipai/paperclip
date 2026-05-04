const postgres = require('postgres');
(async () => {
  const sql = postgres('postgres://postgres:postgres@127.0.0.1:5432/postgres', { ssl: false, max: 2 });

  // Check databases
  const dbs = await sql`SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')`;
  console.log('Databases:', dbs.map(r => r.datname).join(', '));

  // Check tables in paperclip
  const tables = await sql`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
    LIMIT 30
  `;
  console.log('\nTables in public schema (first 30):');
  for (const t of tables) console.log(' ', t.tablename);

  // Check migration tables
  const migrationTables = await sql`
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE tablename LIKE '%migration%' OR tablename = '__drizzle_migrations'
  `;
  console.log('\nMigration tables:', migrationTables.map(r => `${r.schemaname}.${r.tablename}`).join(', '));

  await sql.end();
})();