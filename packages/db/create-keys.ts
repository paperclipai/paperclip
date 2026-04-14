import { createDb } from "./src/client.js";
import { agentApiKeys, agents as agentsTable } from "./src/schema/index.js";
import crypto from "node:crypto";

const DB_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const COMPANY_ID = "517b8249-8b71-4c5a-bee3-a01307c6e792";
const db = createDb(DB_URL);

const targetAgents = ["jenna", "tracy", "liz", "jack", "pete"];

async function createKey(agentId: string, name: string) {
  const token = `pcp_${crypto.randomBytes(24).toString("hex")}`;
  const keyHash = crypto.createHash("sha256").update(token).digest("hex");
  
  const [row] = await db.insert(agentApiKeys).values({
    id: crypto.randomUUID(),
    agentId,
    companyId: COMPANY_ID,
    name,
    keyHash,
    createdAt: new Date(),
    revokedAt: null,
  }).returning();
  
  return { keyId: row.id, token, agentId };
}

async function main() {
  const allAgents = await db.select().from(agentsTable);
  const results: Record<string, any> = {};
  
  for (const target of targetAgents) {
    const agent = allAgents.find((a: any) => a.urlKey === target || a.name?.toLowerCase() === target);
    if (!agent) {
      console.error(`Agent not found: ${target}`);
      continue;
    }
    const result = await createKey(agent.id, "gateway-dispatch");
    results[target] = { token: result.token, agentId: result.agentId, keyId: result.keyId };
    console.log(`${target}: ${result.token}`);
  }
  
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
