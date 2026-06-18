import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

async function main() {
  console.log("Querying DB...");
  const agents = await sql`SELECT id, name, budget_monthly_cents, spent_monthly_cents FROM agents;`;
  console.log("Agents:");
  console.log(agents);

  const costEventsCount = await sql`SELECT COUNT(*) FROM cost_events;`;
  console.log("Cost events count:", costEventsCount[0].count);

  if (parseInt(costEventsCount[0].count) > 0) {
    const costEvents = await sql`SELECT id, agent_id, cost_cents, occurred_at FROM cost_events LIMIT 10;`;
    console.log("Cost events samples:");
    console.log(costEvents);
  }
  
  await sql.end();
}

main().catch(console.error);
