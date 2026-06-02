import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: YouTube studio (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/youtube.
 *
 * Only the aggregate GET /youtube is a pure-DB read and is ported here.
 * The youtube_ideas/scripts/titles/thumbnails/shorts tables are currently
 * empty (0 rows) — the endpoint still returns the correct JSON shape with
 * empty arrays.
 *
 * PHASE 5 (left cross-origin in the UI):
 *  - POST /youtube/trends  → Gemini (LLM) trend generation, no DB read.
 *  - POST /youtube/mine    → Reddit scraper (external fetch), writes ideas.
 *  - The ideas/scripts/titles/thumbnails/shorts POST/PATCH/DELETE write
 *    actions remain on the standalone AGNB app for now.
 */
export function registerYoutube(router: Router, db: Db) {
  /** GET /api/agnb/youtube — all YouTube studio data (ideas/scripts/titles/thumbnails/shorts/performance). */
  router.get("/agnb/youtube", async (req, res) => {
    assertBoardOrgAccess(req);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [ideas, scripts, titles, thumbnails, shorts, performance] = await Promise.all([
      db.execute(sql`
        SELECT id, title, source, source_url, est_views, score, status, notes, created_at
        FROM agnb.youtube_ideas
        ORDER BY score DESC NULLS LAST
        LIMIT 200
      `),
      db.execute(sql`
        SELECT id, title, status, duration_sec, hook_text, publish_at, published_url,
               views, watch_time_pct, ctr_pct, updated_at
        FROM agnb.youtube_scripts
        ORDER BY updated_at DESC
        LIMIT 200
      `),
      db.execute(sql`
        SELECT id, script_id, title, is_winner, ctr_pct, votes, created_at
        FROM agnb.youtube_titles
        ORDER BY created_at DESC
        LIMIT 200
      `),
      db.execute(sql`
        SELECT id, url, concept, is_winner, ctr_pct, created_at
        FROM agnb.youtube_thumbnails
        ORDER BY created_at DESC
        LIMIT 100
      `),
      db.execute(sql`
        SELECT id, parent_script_id, title, hook_sec, duration_sec, caption, status,
               publish_at, views, cross_post_ig
        FROM agnb.youtube_shorts
        ORDER BY publish_at ASC NULLS LAST
        LIMIT 200
      `),
      db.execute(sql`
        SELECT id, platform, url, views, watch_time_sec, ctr_pct, sampled_at
        FROM agnb.content_performance
        WHERE platform IN ('youtube', 'ig') AND sampled_at >= ${since}
        ORDER BY views DESC
        LIMIT 50
      `),
    ]);
    res.json({
      ok: true,
      ideas: rows(ideas),
      scripts: rows(scripts),
      titles: rows(titles),
      thumbnails: rows(thumbnails),
      shorts: rows(shorts),
      performance: rows(performance),
    });
  });
}
