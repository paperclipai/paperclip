const postgres = require('postgres');
const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 2 });

(async () => {
  const cols = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'`;
  console.log('Drizzle migration table columns:', cols);

  const sample = await sql`SELECT * FROM drizzle.__drizzle_migrations LIMIT 2`;
  console.log('\nSample rows:', JSON.stringify(sample, null, 2));
  await sql.end();
})();