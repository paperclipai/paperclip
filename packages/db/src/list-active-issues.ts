import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgres://paperclip:***@localhost:5432/paperclip");

async function main() {
  console.log("=== Active issues ===");
  const issues = await sql`
    SELECT id, identifier, title, status, assignee_agent_id, execution_run_id, execution_locked_at, execution_agent_name_key, priority
    FROM issues 
    WHERE company_id = '5c2551e8-cb65-4ab4-9fee-8e0001be2e41' 
      AND status NOT IN ('done', 'cancelled')
    ORDER BY priority DESC, identifier DESC
  `;
  console.log(JSON.stringify(issues, null, 2));

  await sql.end();
}

main().catch(console.error);
