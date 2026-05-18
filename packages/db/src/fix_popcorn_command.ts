/**
 * Script: corrige el adapterConfig del agente Popcorn Auto
 * cambia command "python" → "python3" para que funcione en Railway.
 *
 * Uso en Railway Console:
 *   DATABASE_URL=$DATABASE_URL npx tsx packages/db/src/fix_popcorn_command.ts
 */
import { createDb } from "./client.js";
import { agents } from "./schema/index.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

const popcornId = process.env.POPCORN_AGENT_ID;
if (!popcornId) throw new Error("POPCORN_AGENT_ID is required");

const [updated] = await db
  .update(agents)
  .set({
    adapterConfig: {
      command: "python3",
      args: ["agents/popcorn.py"],
      cwd: "/app",
    },
  })
  .where(eq(agents.id, popcornId))
  .returning({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig });

if (!updated) {
  console.error(`❌ No se encontró agente con ID: ${popcornId}`);
  process.exit(1);
}

console.log(`✅ Agente "${updated.name}" actualizado:`);
console.log(JSON.stringify(updated.adapterConfig, null, 2));
process.exit(0);
