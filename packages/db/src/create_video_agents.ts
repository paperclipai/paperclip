/**
 * Script de creación de agentes: Video Prompt Generator + Imagen Video (DOP)
 *
 * Uso en Railway Console:
 *   DATABASE_URL=$DATABASE_URL npx tsx packages/db/src/create_video_agents.ts
 *
 * Al finalizar imprime los UUIDs de los agentes creados.
 * Copia esos IDs y añádelos como variables de entorno en Railway:
 *   VIDEO_PROMPT_GENERATOR_AGENT_ID=<uuid>
 *   IMAGEN_VIDEO_AGENT_ID=<uuid>
 */
import { createDb } from "./client.js";
import { companies, agents } from "./schema/index.js";
import { eq, and } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

// ─── 1. Buscar la empresa activa ─────────────────────────────────────────────
const [company] = await db.select().from(companies).limit(1);
if (!company) throw new Error("No se encontró ninguna company en la base de datos");
console.log(`✅ Company encontrada: "${company.name}" (${company.id})`);

// ─── 2. Buscar el director para usar como reportsTo ──────────────────────────
const allAgents = await db
  .select({ id: agents.id, name: agents.name })
  .from(agents)
  .where(eq(agents.companyId, company.id));

console.log(`\n📋 Agentes existentes (${allAgents.length}):`);
for (const a of allAgents) {
  console.log(`   ${a.id}  →  ${a.name}`);
}

const director = allAgents.find((a) =>
  a.name.toLowerCase().includes("director") ||
  a.name.toLowerCase().includes("ceo") ||
  a.name.toLowerCase().includes("content")
);

// ─── 3. Helper: crear agente solo si no existe ────────────────────────────────
async function upsertAgent(agentName: string, config: {
  role?: string;
  title?: string;
  adapterConfig: Record<string, unknown>;
  budgetMonthlyCents?: number;
  reportsTo?: string;
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

// ─── 4. Crear los dos agentes ─────────────────────────────────────────────────
console.log("\n🚀 Creando agentes...");

const videPromptId = await upsertAgent("Video Prompt Generator", {
  title: "Video Motion Prompt Expert",
  adapterConfig: {
    command: "python",
    args: ["agents/video_prompt_generator.py"],
    cwd: "/app",
  },
  budgetMonthlyCents: 3000,
});

const imagenVideoId = await upsertAgent("Imagen Video", {
  title: "Higgsfield DOP Animator",
  adapterConfig: {
    command: "python",
    args: ["agents/imagen_video.py"],
    cwd: "/app",
  },
  budgetMonthlyCents: 8000,
});

// ─── 5. Output final ─────────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  AGENTES CREADOS — copia estos valores como vars de entorno en Railway
╠══════════════════════════════════════════════════════════════════════╣
║  VIDEO_PROMPT_GENERATOR_AGENT_ID=${videPromptId}
║  IMAGEN_VIDEO_AGENT_ID=${imagenVideoId}
╚══════════════════════════════════════════════════════════════════════╝
`);

process.exit(0);
