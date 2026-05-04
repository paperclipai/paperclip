const postgres = require('postgres');
(async () => {
  const sql = postgres('postgres://postgres:postgres@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

  const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
  console.log('Tables:', tables.length);
  for (const t of tables) console.log(' ', t.tablename);

  // Check if the specific table exists
  const exists = await sql`SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'rt2_v33_avatar_subscriptions') as ex`;
  console.log('\nrt2_v33_avatar_subscriptions exists:', exists[0]?.ex);

  await sql.end();
})();