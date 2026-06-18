import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgres://paperclip:***@localhost:5432/paperclip");

async function main() {
  try {
    console.log("=== Active Heartbeat Runs ===");
    const runs = await sql`
      SELECT id, company_id, agent_id, status, invocation_source, trigger_detail, created_at, updated_at
      FROM heartbeat_runs 
      WHERE company_id = '5c2551e8-cb65-4ab4-9fee-8e0001be2e41' 
        AND status NOT IN ('done', 'failed', 'cancelled')
      ORDER BY created_at DESC
    `;
    console.log(JSON.stringify(runs, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch(console.error);
