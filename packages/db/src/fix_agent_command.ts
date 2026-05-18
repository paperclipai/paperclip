/**
 * Corrige el comando de Video Prompt Generator e Imagen Video
 * de "python" a "python3" para que funcionen en el contenedor Railway.
 */
import { createDb } from "./client.js";
import { agents } from "./schema/index.js";
import { eq } from "drizzle-orm";

const db = createDb(process.env.DATABASE_URL!);

// Primero ver qué comando usan los agentes existentes que SÍ funcionan
const all = await db.select({ id: agents.id, name: agents.name, adapterConfig: agents.adapterConfig }).from(agents);
console.log("📋 Comandos actuales de todos los agentes:");
for (const a of all) {
  const cfg = a.adapterConfig as any;
  if (cfg?.command) console.log(`  ${a.name}: "${cfg.command}" ${JSON.stringify(cfg.args ?? [])}`);
}

// Actualizar Video Prompt Generator
const vpg = all.find(a => a.name === "Video Prompt Generator");
const ivid = all.find(a => a.name === "Imagen Video");

if (vpg) {
  await db.update(agents).set({
    adapterConfig: { command: "python3", args: ["agents/video_prompt_generator.py"], cwd: "/app" }
  }).where(eq(agents.id, vpg.id));
  console.log(`\n✅ Video Prompt Generator → python3`);
}

if (ivid) {
  await db.update(agents).set({
    adapterConfig: { command: "python3", args: ["agents/imagen_video.py"], cwd: "/app" }
  }).where(eq(agents.id, ivid.id));
  console.log(`✅ Imagen Video → python3`);
}

process.exit(0);
