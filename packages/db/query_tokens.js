import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

async function main() {
  console.log("Querying DB...");
  const billingTypes = await sql`SELECT billing_type, COUNT(*), SUM(cost_cents) as total_cents FROM cost_events GROUP BY billing_type;`;
  console.log("Billing types:", billingTypes);

  const tokenSummaries = await sql`
    SELECT 
      ce.agent_id,
      COALESCE(a.name, ce.agent_id::text) AS agent_name,
      COUNT(*) as total_calls,
      SUM(ce.input_tokens) as total_input_tokens,
      SUM(ce.cached_input_tokens) as total_cached_input_tokens,
      SUM(ce.output_tokens) as total_output_tokens,
      SUM(ce.cost_cents) as total_cost_cents
    FROM cost_events ce
    LEFT JOIN agents a ON a.id = ce.agent_id
    GROUP BY ce.agent_id, a.name
    ORDER BY total_calls DESC;
  `;
  console.log("Token summaries per agent:");
  console.log(tokenSummaries);

  await sql.end();
}

main().catch(console.error);
