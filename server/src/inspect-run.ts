import postgres from "postgres";

const sql = postgres("postgres://paperclip:paperclip@localhost:5432/paperclip");

async function main() {
  const wakeupRequestId = "052e8983-de18-41ab-94a7-818bcd8fdf0a";
  const runId = "c8456399-823f-470e-8e34-70ac872fbb05";

  console.log("=== Wakeup Request ===");
  const [wakeup] = await sql`SELECT * FROM agent_wakeup_requests WHERE id = ${wakeupRequestId}`;
  console.log(JSON.stringify(wakeup, null, 2));

  console.log("\n=== Execution Run ===");
  const [run] = await sql`SELECT * FROM heartbeat_runs WHERE id = ${runId}`;
  console.log(JSON.stringify(run, null, 2));

  if (run?.agent_id) {
    console.log("\n=== Agent ===");
    const [agent] = await sql`SELECT * FROM agents WHERE id = ${run.agent_id}`;
    console.log(JSON.stringify(agent, null, 2));
  }

  await sql.end();
}

main().catch(console.error);
