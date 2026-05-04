const postgres = require('postgres');
(async () => {
  const sql = postgres('postgres://postgres:postgres@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

  // Check ALL objects in public schema
  const objects = await sql`
    SELECT object_type, object_name
    FROM (
      SELECT 'table' as object_type, tablename as object_name
      FROM pg_tables WHERE schemaname = 'public'
      UNION ALL
      SELECT 'view', viewname FROM pg_views WHERE schemaname = 'public'
      UNION ALL
      SELECT 'sequence', seqname FROM pg_sequences WHERE schemaname = 'public'
      UNION ALL
      SELECT 'materialized view', matviewname FROM pg_matviews WHERE schemaname = 'public'
    ) t
    ORDER BY object_type, object_name
  `;
  console.log('Objects in public schema:', objects.length);
  for (const o of objects) console.log(`  ${o.object_type}: ${o.object_name}`);

  // Check pg_catalog too
  const rt2 = await sql`
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname ILIKE '%rt2%'
  `;
  console.log('\nrt2 objects in public:', rt2);

  // Try to create the table to see the actual error
  try {
    await sql.unsafe('CREATE TABLE "rt2_v33_avatar_subscriptions" (id serial PRIMARY KEY)');
    console.log('CREATE TABLE succeeded (table does not exist)');
  } catch(e) {
    console.log('CREATE TABLE failed:', e.message.slice(0, 100));
  }

  await sql.end();
})();