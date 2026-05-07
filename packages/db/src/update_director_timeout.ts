/**
 * Aumenta timeoutSec del Director a 900s (15 min).
 * El campo real que usa Paperclip es timeoutSec, no timeout.
 */
import { createDb } from "./client.js";
import { agents } from "./schema/index.js";
import { eq } from "drizzle-orm";

const db = createDb(process.env.DATABASE_URL!);

const all = await db.select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);

// Actualizar Director principal (el que tiene el pipeline completo)
// Hay dos "Director" — buscar el que tiene agents/director.py
const directors = all.filter(a => a.name === "Director");
for (const director of directors) {
  const cfg = director.adapterConfig as any;
  const args = cfg?.args ?? [];
  if (!args.some((a: string) => a.includes("director.py"))) continue;

  console.log(`\n🎬 Director encontrado: ${director.id}`);
  console.log(`   timeoutSec actual: ${cfg.timeoutSec ?? "no configurado"}`);

  await db.update(agents).set({
    adapterConfig: { ...cfg, timeoutSec: 900, timeout: 900 }
  }).where(eq(agents.id, director.id));

  console.log(`✅ timeoutSec → 900s (15 min)`);
}

// También actualizar Video Assembler y Imagen Video para que tengan margen
const videoAgents = all.filter(a =>
  ["Video Assembler", "Imagen Video", "Video Prompt Generator"].includes(a.name)
);
for (const agent of videoAgents) {
  const cfg = agent.adapterConfig as any;
  await db.update(agents).set({
    adapterConfig: { ...cfg, timeoutSec: 600, timeout: 600 }
  }).where(eq(agents.id, agent.id));
  console.log(`✅ ${agent.name} → timeoutSec 600s`);
}

process.exit(0);
