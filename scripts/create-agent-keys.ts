import { createDb } from "../server/src/db/index.ts";
import { agentApiKeys, agents as agentsTable } from "../server/src/db/schema.ts";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const DB_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const db = createDb(DB_URL);

const targetAgents = ["jenna", "tracy", "liz", "jack", "pete"];

async function createKey(agentId: string, name: string) {
  const token = `pcp_${crypto.randomBytes(24).toString("hex")}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  
  const [row] = await db.insert(agentApiKeys).values({
    id: crypto.randomUUID(),
    agentId,
    name,
    tokenHash,
    createdAt: new Date(),
    revokedAt: null,
  }).returning();
  
  return { keyId: row.id, token, agentId };
}

async function main() {
  const allAgents = await db.select().from(agentsTable);
  const results: Record<string, any> = {};
  
  for (const target of targetAgents) {
    const agent = allAgents.find(a => a.urlKey === target || a.name?.toLowerCase() === target);
    if (!agent) {
      console.error(`Agent not found: ${target}`);
      continue;
    }
    
    const result = await createKey(agent.id, "gateway-dispatch");
    results[target] = result;
    console.log(`${target}: ${result.token}`);
  }
  
  console.log("\n=== JSON ===");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
