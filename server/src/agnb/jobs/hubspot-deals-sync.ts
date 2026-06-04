import { sql } from "drizzle-orm";
import { hsFetch, type HsDeal } from "../lib/hubspot.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * hubspot-deals-sync — HubSpot CRM deals → agnb.hubspot_deals mirror, the source
 * for the Pipeline board (GET /api/agnb/pipeline/board) and the weighted
 * forecast. The standalone AGNB app read deals live from HubSpot; with that app
 * decommissioned, this job keeps the mirror current so the ported pages work.
 * Upserts by HubSpot deal id; the Sales-Ops Analyst agent can also push deals
 * via POST /api/agnb/pipeline/deals between syncs.
 *
 * Cadence: hourly. requiresEnv: HUBSPOT_TOKEN (or HUBSPOT_API_KEY).
 */
export async function hubspotDealsSync(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const MAX_PAGES = 20;
  let after: string | undefined;
  let upserted = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (ctx.signal.aborted) return { ok: false, summary: "aborted", upserted };
    const qs = new URLSearchParams({ limit: "100", properties: "dealname,dealstage,amount,closedate" });
    if (after) qs.set("after", after);
    const resp = await hsFetch<HsDeal>(`/crm/v3/objects/deals?${qs.toString()}`);

    for (const d of resp.results) {
      const id = String(d.id);
      const dealname = (d.properties.dealname ?? "").trim() || "(unnamed deal)";
      const dealstage = (d.properties.dealstage ?? "").trim() || "unknown";
      const amountRaw = d.properties.amount;
      const amount =
        amountRaw != null && amountRaw !== "" && !Number.isNaN(Number(amountRaw)) ? Number(amountRaw) : null;
      const closeDate = d.properties.closedate || null;

      const upd = await db.execute(sql`
        UPDATE agnb.hubspot_deals
        SET dealname = ${dealname}, dealstage = ${dealstage},
            amount_usd = COALESCE(${amount}, amount_usd),
            close_date = COALESCE(${closeDate}::timestamptz, close_date)
        WHERE id = ${id}
        RETURNING id
      `);
      if (rows(upd).length === 0) {
        await db.execute(sql`
          INSERT INTO agnb.hubspot_deals (id, dealname, dealstage, amount_usd, close_date)
          VALUES (${id}, ${dealname}, ${dealstage}, ${amount}, ${closeDate}::timestamptz)
        `);
      }
      upserted++;
    }

    after = resp.paging?.next?.after;
    if (!after) break;
  }

  ctx.log(`hubspot-deals-sync upserted ${upserted} deals`);
  return { ok: true, upserted, summary: `synced ${upserted} HubSpot deals` };
}
