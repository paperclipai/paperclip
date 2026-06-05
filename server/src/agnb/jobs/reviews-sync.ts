import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { platformRating } from "../lib/serpapi.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * reviews-sync — fills review-platform aggregate ratings (the Reviews Radar)
 * via SerpAPI, bypassing the bot-walls that 403 a raw fetch. For each tracked
 * platform it pulls the current rating + review count and snapshots them.
 * Complements the Reviews Monitor agent (which gathers individual review
 * entries); this keeps the headline ratings fresh without scraping the sites
 * directly. Best-effort: a platform with no rating found is skipped.
 *
 * Cadence: daily. requiresEnv: SERPAPI_KEY. Brand from AGNB_BRAND_NAME (default "Finn").
 */
export async function reviewsSync(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const brand = process.env.AGNB_BRAND_NAME || "Finn";

  const platforms = rows<{ id: string; platform: string; profile_url: string }>(
    await db.execute(sql`SELECT id, platform, profile_url FROM agnb.review_platforms ORDER BY platform`),
  );

  let updated = 0;
  for (const p of platforms) {
    if (ctx.signal.aborted) break;
    let res;
    try {
      res = await platformRating(brand, p.platform, domainOf(p.profile_url));
    } catch (e) {
      ctx.log(`reviews-sync ${p.platform} error: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
      continue;
    }
    if (res.rating == null) {
      ctx.log(`reviews-sync ${p.platform}: no rating found`);
      continue;
    }
    await db.execute(sql`
      UPDATE agnb.review_platforms
      SET rating = ${res.rating},
          review_count = COALESCE(${res.reviews}, review_count),
          last_checked_at = now()
      WHERE id = ${p.id}
    `);
    updated++;
  }

  ctx.log(`reviews-sync updated ${updated}/${platforms.length} platform ratings`);
  return { ok: true, updated, total: platforms.length, summary: `updated ${updated} review platform ratings via SerpAPI` };
}
