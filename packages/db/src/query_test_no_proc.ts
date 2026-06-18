import { createDb } from "./client.js";
import { sql } from "drizzle-orm";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("No DATABASE_URL found in env!");
    process.exit(1);
  }
  console.log("Connecting to database using process.env.DATABASE_URL...");
  try {
    const db = createDb(url);
    const result = await db.execute(sql`SELECT 1 as one`);
    console.log("Query result:", JSON.stringify(result));
  } catch (err) {
    console.error("Connection failed:", err);
  }
}

main();
