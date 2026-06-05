import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: north-star — one aggregate of the KPIs the company steers by
 * (pipeline, share of voice, reviews, mentions, backlinks, content). Backs the
 * exec dashboard and gives the CEO daily-review loop its scoreboard.
 */
export function registerNorthstar(router: Router, db: Db) {
  /** GET /api/agnb/north-star — headline KPIs across the funnel. */
  router.get("/agnb/north-star", async (req, res) => {
    assertAgnbAccess(req);
    const [pipeline, sov, reviews, mentions, backlinks, prospects, gaps, ideas] = await Promise.all([
      db.execute(sql`
        SELECT count(*)::int AS deals, COALESCE(SUM(amount_usd::float8), 0)::float8 AS total
        FROM agnb.hubspot_deals
        WHERE dealstage IS NULL OR dealstage NOT ILIKE '%closedlost%'`),
      db.execute(sql`
        SELECT (count(*) FILTER (WHERE brand_mentioned))::int AS hit, count(*)::int AS total
        FROM agnb.sov_results WHERE ran_at >= now() - interval '30 days'`),
      db.execute(sql`
        SELECT AVG(rating::float8)::float8 AS avg_rating, COALESCE(SUM(review_count::int), 0)::int AS total_reviews, count(*)::int AS platforms
        FROM agnb.review_platforms WHERE rating IS NOT NULL`),
      db.execute(sql`
        SELECT count(*)::int AS total,
               (count(*) FILTER (WHERE sentiment = 'positive'))::int AS positive,
               (count(*) FILTER (WHERE sentiment IN ('negative', 'objection')))::int AS negative
        FROM agnb.community_mentions WHERE noticed_at >= now() - interval '30 days'`),
      db.execute(sql`SELECT count(*)::int AS earned FROM agnb.backlinks WHERE status IN ('active', 'live')`),
      db.execute(sql`SELECT count(*)::int AS open FROM agnb.backlink_prospects WHERE status = 'new'`),
      db.execute(sql`SELECT count(*)::int AS open FROM agnb.content_gaps WHERE status = 'identified'`),
      db.execute(sql`SELECT count(*)::int AS inbox FROM agnb.blog_ideas WHERE status = 'inbox'`),
    ]);

    const p = rows<{ deals: number; total: number }>(pipeline)[0];
    const s = rows<{ hit: number; total: number }>(sov)[0];
    const r = rows<{ avg_rating: number | null; total_reviews: number; platforms: number }>(reviews)[0];
    const m = rows<{ total: number; positive: number; negative: number }>(mentions)[0];

    res.json({
      ok: true,
      pipeline: { open_deals: p?.deals ?? 0, open_value_usd: Math.round(p?.total ?? 0) },
      sov: { mention_rate: s && s.total > 0 ? Math.round((s.hit / s.total) * 100) : null, runs: s?.total ?? 0 },
      reviews: {
        avg_rating: r?.avg_rating != null ? Math.round(r.avg_rating * 100) / 100 : null,
        total_reviews: r?.total_reviews ?? 0,
        platforms: r?.platforms ?? 0,
      },
      mentions: { total_30d: m?.total ?? 0, positive: m?.positive ?? 0, negative: m?.negative ?? 0 },
      backlinks: { earned: rows<{ earned: number }>(backlinks)[0]?.earned ?? 0, prospects: rows<{ open: number }>(prospects)[0]?.open ?? 0 },
      content: { open_gaps: rows<{ open: number }>(gaps)[0]?.open ?? 0, idea_inbox: rows<{ inbox: number }>(ideas)[0]?.inbox ?? 0 },
    });
  });
}
