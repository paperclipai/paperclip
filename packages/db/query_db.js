import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

async function main() {
  console.log("Querying DB...");
  const nonZero = await sql`SELECT COUNT(*), SUM(cost_cents) as total_cents FROM cost_events WHERE cost_cents > 0;`;
  console.log("Non-zero cost events info:", nonZero);

  const modelCosts = await sql`SELECT model, provider, COUNT(*), SUM(cost_cents) as total_cents FROM cost_events GROUP BY model, provider ORDER BY COUNT(*) DESC;`;
  console.log("Model cost events group:");
  console.log(modelCosts);

  await sql.end();
}

main().catch(console.error);
