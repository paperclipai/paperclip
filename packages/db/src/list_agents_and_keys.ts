import { createDb } from "./client.js";
import { sql } from "drizzle-orm";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("No DATABASE_URL found in env!");
    process.exit(1);
  }
  const db = createDb(url);
  try {
    const agents = await db.execute(sql`SELECT * FROM agents`);
    console.log("AGENTS:");
    console.log(JSON.stringify(agents, null, 2));

    const keys = await db.execute(sql`SELECT * FROM agent_api_keys`);
    console.log("KEYS:");
    console.log(JSON.stringify(keys, null, 2));
  } catch (err) {
    console.error("Failed to query:", err);
  } finally {
    process.exit(0);
  }
}

main();
