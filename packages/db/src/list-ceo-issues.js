import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL || "postgres://paperclip:***@localhost:5432/paperclip");

async function main() {
  console.log("=== CEO-assigned or locked issues ===");
  const issues = await sql`
    SELECT id, identifier, title, status, assignee_agent_id, execution_run_id, execution_locked_at, execution_agent_name_key, priority
    FROM issues 
    WHERE company_id = '5c2551e8-cb65-4ab4-9fee-8e0001be2e41' 
      AND (assignee_agent_id = 'aa2a7162-065c-49d5-a48d-309f04206e06' OR execution_agent_name_key = 'ceo')
  `;
  console.log(JSON.stringify(issues, null, 2));

  await sql.end();
}

main().catch(console.error);
