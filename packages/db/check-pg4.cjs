const postgres = require('postgres');
(async () => {
  const sql = postgres('postgres://postgres:postgres@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

  // Check drizzle migration tables
  const drizzleSchema = await sql`SELECT nspname FROM pg_namespace WHERE nspname = 'drizzle'`;
  console.log('drizzle schema exists:', drizzleSchema.length > 0);

  if (drizzleSchema.length > 0) {
    const migrations = await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`;
    console.log('Drizzle migrations:', migrations.length);
    for (const m of migrations.slice(-5)) console.log(' ', m);
  } else {
    console.log('No drizzle schema - checking for migration tracking');
    // Check for any migration tracking
    const tracking = await sql`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE tablename LIKE '%migrat%' OR tablename LIKE '%journal%'
    `;
    console.log('Migration tracking tables:', tracking.map(r => `${r.schemaname}.${r.tablename}`).join(', '));
  }

  await sql.end();
})();