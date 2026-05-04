// Try to connect to running postgres at 54329 and run migration statements
const postgres = require('postgres');

async function main() {
  // Try connecting to the running postgres
  let sql;
  try {
    sql = postgres('postgres://paperclip:paperclip@127.0.0.1:54329/paperclip', { max: 1, ssl: false, onnotice: () => {} });
    const result = await sql`SELECT 1 as test`;
    console.log('Connected! Result:', result);
  } catch(e) {
    console.log('Connection failed:', e.message);
    try {
      sql = postgres('postgres://postgres:postgres@127.0.0.1:54329/postgres', { max: 1, ssl: false, onnotice: () => {} });
      const result = await sql`SELECT 1 as test`;
      console.log('Connected to postgres DB! Result:', result);
    } catch(e2) {
      console.log('Also failed:', e2.message);
    }
  }

  if (sql) await sql.end();
}

main().catch(e => console.error(e));