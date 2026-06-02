import { sql } from "drizzle-orm";
import { gscQuery, getValidGoogleAccessToken } from "../lib/google-oauth.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * gsc-rank-tracker — daily. Pulls last 7d GSC data for the configured property
 * (dimensions page+query), upserts into agnb.gsc_rank_data (one row per
 * (blog_url, query, capture_date)).
 *
 * Then: feedback loop into agnb.content_gaps — for any blog ranking page-2+
 * (avg position >= 11) on its top query, boost gap_score for related topics
 * ("we tried but didn't rank — refresh / double-down").
 *
 * Ported from agnb api/internal/gsc-rank-tracker. Bearer CRON_SECRET gate
 * removed. Requires GOOGLE_OAUTH_CLIENT_ID/SECRET to refresh the stored token,
 * GSC_PROPERTY env, and a connected token row in agnb.oauth_tokens — no-ops
 * gracefully if any are missing.
 */
export async function gscRankTracker(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, log } = ctx;

  const property = process.env.GSC_PROPERTY;
  if (!property) return { ok: true, summary: "skipped: GSC_PROPERTY env not set" };

  const token = await getValidGoogleAccessToken(db);
  if (!token) return { ok: true, summary: "skipped: Google not connected (no agnb.oauth_tokens row)" };

  // GSC has a 2-3 day lag — query last 7d to be safe
  const endDate = isoDate(new Date(Date.now() - 3 * 86_400_000));
  const startDate = isoDate(new Date(Date.now() - 10 * 86_400_000));

  let gscRows;
  try {
    gscRows = await gscQuery(db, {
      propertyUrl: property,
      startDate,
      endDate,
      dimensions: ["page", "query"],
      rowLimit: 5_000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("gsc query failed", { error: msg });
    return { ok: false, summary: `gsc query failed: ${msg}` };
  }

  // Filter to blog URLs only
  const blogRows = gscRows.filter((r) => r.keys?.[0]?.includes("/blog/"));

  const captureDate = isoDate(new Date());
  let upserts = 0;

  for (const r of blogRows) {
    if (ctx.signal.aborted) break;
    const res = await db.execute(sql`
      INSERT INTO agnb.gsc_rank_data (blog_url, query, position, clicks, impressions, ctr, capture_date)
      VALUES (${r.keys[0]}, ${r.keys[1]}, ${r.position}, ${r.clicks}, ${r.impressions}, ${r.ctr}, ${captureDate})
      ON CONFLICT (blog_url, query, capture_date) DO UPDATE SET
        position = EXCLUDED.position,
        clicks = EXCLUDED.clicks,
        impressions = EXCLUDED.impressions,
        ctr = EXCLUDED.ctr
    `);
    upserts += (res as { rowCount?: number })?.rowCount ?? 0;
  }

  // Feedback loop: blogs ranking page-2+ on their top (most-clicked) query →
  // boost matching content_gaps.
  const byUrl = new Map<string, { topQuery: string; pos: number; clicks: number }>();
  for (const r of blogRows) {
    const url = r.keys[0];
    const query = r.keys[1];
    const cur = byUrl.get(url);
    if (!cur || r.clicks > cur.clicks) byUrl.set(url, { topQuery: query, pos: r.position, clicks: r.clicks });
  }

  let boosted = 0;
  for (const [, info] of byUrl.entries()) {
    if (ctx.signal.aborted) break;
    if (info.pos < 11) continue; // page 1 = fine, no boost needed
    // Simple substring match — gaps whose topic appears in the struggling
    // query are good refresh candidates.
    const needle = `%${info.topQuery.split(" ").slice(0, 2).join(" ")}%`;
    const matchingGaps = rows<{ id: string; gap_score: number | string | null }>(
      await db.execute(sql`
        SELECT id, gap_score FROM agnb.content_gaps
        WHERE topic ILIKE ${needle}
        LIMIT 5
      `),
    );
    for (const g of matchingGaps) {
      const newScore = Math.min(100, Number(g.gap_score ?? 0) + 10);
      await db.execute(sql`
        UPDATE agnb.content_gaps
        SET gap_score = ${newScore}, updated_at = now()
        WHERE id = ${g.id}
      `);
      boosted++;
    }
  }

  const page2Blogs = Array.from(byUrl.values()).filter((v) => v.pos >= 11).length;
  log("gsc rank tracker done", { total_rows: gscRows.length, blog_rows: blogRows.length, upserts, boosted });

  return {
    ok: true,
    period: `${startDate} → ${endDate}`,
    total_rows: gscRows.length,
    blog_rows: blogRows.length,
    upserts,
    page2_blogs: page2Blogs,
    gaps_boosted: boosted,
    summary: `${upserts} rows upserted, ${boosted} gaps boosted`,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
