/**
 * Script de creación de agente: Popcorn Auto (Higgsfield)
 *
 * Uso en Railway Console:
 *   DATABASE_URL=$DATABASE_URL npx tsx packages/db/src/create_popcorn_agent.ts
 *
 * Al finalizar imprime el UUID del agente creado.
 * Copia ese ID y añádelo como variable de entorno en Railway:
 *   POPCORN_AGENT_ID=<uuid>
 */
import { createDb } from "./client.js";
import { companies, agents } from "./schema/index.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

// ─── 1. Buscar la empresa activa ─────────────────────────────────────────────
const [company] = await db.select().from(companies).limit(1);
if (!company) throw new Error("No se encontró ninguna company en la base de datos");
console.log(`✅ Company encontrada: "${company.name}" (${company.id})`);

// ─── 2. Listar agentes existentes ────────────────────────────────────────────
const allAgents = await db
  .select({ id: agents.id, name: agents.name })
  .from(agents)
  .where(eq(agents.companyId, company.id));

console.log(`\n📋 Agentes existentes (${allAgents.length}):`);
for (const a of allAgents) {
  console.log(`   ${a.id}  →  ${a.name}`);
}

const director = allAgents.find((a) =>
  a.name.toLowerCase().includes("director")
);

// ─── 3. Helper: crear agente solo si no existe ────────────────────────────────
async function upsertAgent(agentName: string, config: {
  role?: string;
  title?: string;
  adapterConfig: Record<string, unknown>;
  budgetMonthlyCents?: number;
  reportsTo?: string | null;
}) {
  const existing = allAgents.find(
    (a) => a.name.toLowerCase() === agentName.toLowerCase()
  );
  if (existing) {
    console.log(`  ⚠️  "${agentName}" ya existe → ID: ${existing.id}`);
    return existing.id;
  }

  const [created] = await db
    .insert(agents)
    .values({
      companyId: company!.id,
      name: agentName,
      role: config.role ?? "engineer",
      title: config.title ?? agentName,
      status: "idle",
      adapterType: "process",
      adapterConfig: config.adapterConfig,
      budgetMonthlyCents: config.budgetMonthlyCents ?? 5000,
      reportsTo: config.reportsTo ?? director?.id ?? null,
    })
    .returning({ id: agents.id });

  console.log(`  ✅ "${agentName}" creado → ID: ${created!.id}`);
  return created!.id;
}

// ─── 4. Crear el agente ───────────────────────────────────────────────────────
console.log("\n🚀 Creando agente Popcorn Auto...");

const popcornId = await upsertAgent("Popcorn Auto", {
  title: "Higgsfield Coherent Image Generator",
  adapterConfig: {
    command: "python",
    args: ["agents/popcorn.py"],
    cwd: "/app",
  },
  budgetMonthlyCents: 6000,
});

// ─── 5. Output final ─────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  AGENTE CREADO — copia este valor como var de entorno en Railway
╠══════════════════════════════════════════════════════════════════════╣
║  POPCORN_AGENT_ID=${popcornId}
╚══════════════════════════════════════════════════════════════════════╝
`);

process.exit(0);
