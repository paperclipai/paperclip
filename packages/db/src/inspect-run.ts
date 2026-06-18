import postgres from "postgres";

const sql = postgres("postgres://paperclip:paperclip@localhost:5432/paperclip");

async function main() {
  console.log("=== Issues with 'target' in Title or Description ===");
  const issues = await sql`
    SELECT id, identifier, title, status, assignee_agent_id 
    FROM issues 
    WHERE company_id = '5c2551e8-cb65-4ab4-9fee-8e0001be2e41' 
      AND (title ILIKE '%target%' OR description ILIKE '%target%')
    ORDER BY created_at DESC
  `;
  console.log(JSON.stringify(issues, null, 2));

  await sql.end();
}

main().catch(console.error);
