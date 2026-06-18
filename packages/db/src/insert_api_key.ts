import { createDb } from "./client.js";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("No DATABASE_URL found in env!");
    process.exit(1);
  }

  const token = "paperclip-ceo-key-token-2026-super-secret";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  console.log("Token Hash to insert:", tokenHash);

  const db = createDb(url);
  try {
    // Check if it already exists
    const existing = await db.execute(sql`
      SELECT * FROM agent_api_keys 
      WHERE key_hash = ${tokenHash}
    `);
    
    if (existing.length > 0) {
      console.log("API Key already exists in database!");
    } else {
      console.log("Inserting API Key...");
      await db.execute(sql`
        INSERT INTO agent_api_keys (agent_id, company_id, name, key_hash)
        VALUES ('aa2a7162-065c-49d5-a48d-309f04206e06', '5c2551e8-cb65-4ab4-9fee-8e0001be2e41', 'hermes-ceo-key', ${tokenHash})
      `);
      console.log("API Key successfully inserted!");
    }
  } catch (err) {
    console.error("Failed to insert API key:", err);
  } finally {
    process.exit(0);
  }
}

main();
