import { sql } from "drizzle-orm";
import { listPersonas, hasRocketKey } from "../lib/rocketsdr-client.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * rocket-personas — pull the Rocket SDR persona catalog and upsert into
 * agnb.rocket_personas. Ported from agnb api/internal/rocket/personas
 * (which served the live list); as a cron we persist the snapshot so the
 * dashboard can read it without hitting the upstream API on every render.
 *
 * Env: ROCKETSDR_API_KEY (or ROCKET_MCP_TOKEN). No-ops if unset.
 */
export async function rocketPersonas(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  if (!hasRocketKey()) return { ok: true, processed: 0, summary: "skipped: no key" };
  const { db } = ctx;

  const { personas } = await listPersonas({ db });
  let upserted = 0;
  for (const p of personas) {
    if (ctx.signal.aborted) break;
    await db.execute(sql`
      INSERT INTO agnb.rocket_personas (id, name, title, raw, synced_at)
      VALUES (${p.id}, ${p.name ?? null}, ${p.title ?? null}, ${JSON.stringify(p)}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        title = EXCLUDED.title,
        raw = EXCLUDED.raw,
        synced_at = now()
    `);
    upserted += 1;
  }
  ctx.log("rocket personas synced", { count: upserted });
  return { ok: true, processed: upserted, summary: `${upserted} personas` };
}
