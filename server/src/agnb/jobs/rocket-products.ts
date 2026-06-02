import { sql } from "drizzle-orm";
import { listProducts, hasRocketKey } from "../lib/rocketsdr-client.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * rocket-products — pull the Rocket SDR product catalog and upsert into
 * agnb.rocket_products. Ported from agnb api/internal/rocket/products
 * (which served the live list); as a cron we persist the snapshot so the
 * dashboard can read it without hitting the upstream API on every render.
 *
 * Env: ROCKETSDR_API_KEY (or ROCKET_MCP_TOKEN). No-ops if unset.
 */
export async function rocketProducts(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  if (!hasRocketKey()) return { ok: true, processed: 0, summary: "skipped: no key" };
  const { db } = ctx;

  const { products } = await listProducts({ db });
  let upserted = 0;
  for (const p of products) {
    if (ctx.signal.aborted) break;
    await db.execute(sql`
      INSERT INTO agnb.rocket_products (id, name, description, raw, synced_at)
      VALUES (${p.id}, ${p.name ?? null}, ${p.description ?? null}, ${JSON.stringify(p)}::jsonb, now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        raw = EXCLUDED.raw,
        synced_at = now()
    `);
    upserted += 1;
  }
  ctx.log("rocket products synced", { count: upserted });
  return { ok: true, processed: upserted, summary: `${upserted} products` };
}
