import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

async function main() {
  console.log("Querying Finance Events...");
  const count = await sql`SELECT COUNT(*) FROM finance_events;`;
  console.log("Finance events count:", count[0].count);

  if (parseInt(count[0].count) > 0) {
    const samples = await sql`SELECT * FROM finance_events LIMIT 10;`;
    console.log("Finance events samples:");
    console.log(samples);
  }

  await sql.end();
}

main().catch(console.error);
