const postgres = require('postgres');
(async () => {
  // Try to connect as paperclip user (like embedded postgres expects)
  try {
    const sql = postgres('postgres://paperclip:paperclip@127.0.0.1:5432/paperclip', { ssl: false, max: 1, connect_timeout: 5 });
    await sql`SELECT 1`;
    console.log('paperclip/paperclip@5432/paperclip: WORKS');
    await sql.end();
  } catch (e) {
    console.log('paperclip/paperclip@5432/paperclip: FAILED -', e.message.slice(0, 100));
  }

  // Try postgres/postgres
  try {
    const sql = postgres('postgres://postgres:postgres@127.0.0.1:5432/postgres', { ssl: false, max: 1, connect_timeout: 5 });
    await sql`SELECT version()`;
    console.log('postgres/postgres@5432/postgres: WORKS');
    console.log('Version:', (await sql`SELECT version()`)[0]?.version?.slice(0, 50));
    await sql.end();
  } catch (e) {
    console.log('postgres/postgres@5432/postgres: FAILED -', e.message.slice(0, 100));
  }
})();