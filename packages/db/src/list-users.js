import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || "postgres://paperclip:paperclip@localhost:5432/paperclip");

async function main() {
  const users = await sql`SELECT id, name, email FROM users`;
  console.log(JSON.stringify(users, null, 2));
  await sql.end();
}

main().catch(console.error);
