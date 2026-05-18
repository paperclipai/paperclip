/**
 * Mueve los agentes recién creados a la compañía correcta
 * y lista todos los agentes por compañía para diagnóstico.
 */
import { createDb } from "./client.js";
import { companies, agents } from "./schema/index.js";
import { eq, inArray } from "drizzle-orm";

const db = createDb(process.env.DATABASE_URL!);

// 1. Listar todas las compañías y sus agentes
const allCompanies = await db.select().from(companies);
console.log("\n📋 COMPAÑÍAS EN LA BD:");
for (const c of allCompanies) {
  const agentList = await db.select({ id: agents.id, name: agents.name })
    .from(agents).where(eq(agents.companyId, c.id));
  console.log(`\n  [${c.id}] "${c.name}" — ${agentList.length} agentes:`);
  for (const a of agentList) console.log(`    ${a.id}  →  ${a.name}`);
}

// 2. Identificar la compañía correcta (la que tiene más agentes)
const companyCounts = await Promise.all(
  allCompanies.map(async (c) => {
    const count = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, c.id));
    return { ...c, count: count.length };
  })
);
const correct = companyCounts.sort((a, b) => b.count - a.count)[0];

if (!correct) throw new Error("No hay compañías");

console.log(`\n✅ Compañía correcta detectada: "${correct.name}" (${correct.id}) — ${correct.count} agentes`);

// 3. Mover Video Prompt Generator e Imagen Video si están en compañía equivocada
const wrongAgents = await db.select().from(agents).where(
  inArray(agents.name, ["Video Prompt Generator", "Imagen Video"])
);

for (const a of wrongAgents) {
  if (a.companyId !== correct.id) {
    await db.update(agents).set({ companyId: correct.id }).where(eq(agents.id, a.id));
    console.log(`  🔄 "${a.name}" movido a compañía correcta`);
  } else {
    console.log(`  ✅ "${a.name}" ya está en la compañía correcta`);
  }
}

// 4. Imprimir IDs finales
const vpg  = await db.select().from(agents).where(eq(agents.name, "Video Prompt Generator")).limit(1);
const ivid = await db.select().from(agents).where(eq(agents.name, "Imagen Video")).limit(1);

console.log(`
VIDEO_PROMPT_GENERATOR_AGENT_ID=${vpg[0]?.id ?? "NO ENCONTRADO"}
IMAGEN_VIDEO_AGENT_ID=${ivid[0]?.id ?? "NO ENCONTRADO"}
`);

process.exit(0);
