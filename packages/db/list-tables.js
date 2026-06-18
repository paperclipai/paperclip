import postgres from 'postgres';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  const sql = postgres(dbUrl);
  try {
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    console.log("Tables in database:");
    for (const t of tables) {
      console.log(t.table_name);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await sql.end();
  }
}

main();
