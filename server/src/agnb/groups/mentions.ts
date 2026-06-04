import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: mentions / reviews / share-of-voice / backlinks (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{mentions,reviews,sov,backlinks,backlink-prospects}.
 *
 * Write actions (POST/DELETE) and external-API routes stay on the standalone
 * AGNB app for now:
 *   - POST/DELETE /reviews, /sov, /backlinks         → PHASE 5 (writes)
 *   - POST /inbound/mentions/sync                     → PHASE 5 (external scrapers)
 *   - POST /inbound/sov/run                           → PHASE 5 (external LLM engines)
 *   - POST /backlinks/draft-outreach/:id              → PHASE 5 (external LLM)
 *   - POST /backlinks/prospect-status/:id             → PHASE 5 (writes)
 *
 * Exception: POST /agnb/mentions — ingest path for the Brand Monitor agent so its
 * web-search findings persist into community_mentions (the Mentions dashboard's
 * source), replacing the retired standalone scraper. Idempotent on url.
 */
export function registerMentions(router: Router, db: Db) {
  /** GET /api/agnb/mentions — community mentions (HN/Reddit/etc). */
  router.get("/agnb/mentions", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, source, url, context, sentiment, author, has_link, noticed_at
      FROM agnb.community_mentions
      ORDER BY noticed_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, mentions: rows(result) });
  });

  /**
   * POST /api/agnb/mentions — ingest a brand mention (Brand Monitor agent).
   * Idempotent on url: a mention whose url already exists is skipped (no dupes
   * across weekly re-runs). Rows are tagged noticed_by='brand-monitor' so they
   * can be told apart from legacy-scraper rows during the shadow period.
   */
  router.post("/agnb/mentions", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as {
      source?: string;
      url?: string;
      context?: string;
      sentiment?: string;
      author?: string;
      has_link?: boolean;
      noticed_at?: string;
      noticed_by?: string;
    };
    if (!body.source || !body.url) {
      res.status(400).json({ ok: false, error: "source and url are required" });
      return;
    }
    const result = await db.execute(sql`
      INSERT INTO agnb.community_mentions
        (source, url, context, sentiment, author, has_link, noticed_at, noticed_by)
      SELECT ${body.source}, ${body.url}, ${body.context ?? null}, ${body.sentiment ?? null},
             ${body.author ?? null}, ${body.has_link ?? false},
             COALESCE(${body.noticed_at ?? null}::timestamptz, now()),
             ${body.noticed_by ?? "brand-monitor"}
      WHERE NOT EXISTS (
        SELECT 1 FROM agnb.community_mentions WHERE url = ${body.url}
      )
      RETURNING id
    `);
    const inserted = rows(result);
    res.json({ ok: true, inserted: inserted.length > 0, duplicate: inserted.length === 0, id: inserted[0]?.id ?? null });
  });

  /** GET /api/agnb/reviews — review platforms + recent review log. */
  router.get("/agnb/reviews", async (req, res) => {
    assertBoardOrgAccess(req);
    const [platforms, log] = await Promise.all([
      db.execute(sql`
        SELECT id, platform, profile_url, category, rating, review_count, ranked_position, last_checked_at
        FROM agnb.review_platforms
        ORDER BY platform
      `),
      db.execute(sql`
        SELECT id, platform, reviewer_handle, rating, excerpt, review_url, collected_at
        FROM agnb.review_log
        ORDER BY collected_at DESC
        LIMIT 50
      `),
    ]);
    res.json({ ok: true, platforms: rows(platforms), log: rows(log) });
  });

  /** GET /api/agnb/sov — share-of-voice prompts + recent results. */
  router.get("/agnb/sov", async (req, res) => {
    assertBoardOrgAccess(req);
    const [prompts, results] = await Promise.all([
      db.execute(sql`
        SELECT id, prompt, category
        FROM agnb.sov_prompts
        ORDER BY created_at
      `),
      db.execute(sql`
        SELECT id, prompt_id, engine, ran_at, brand_mentioned, position, competitors_mentioned
        FROM agnb.sov_results
        ORDER BY ran_at DESC
        LIMIT 500
      `),
    ]);
    res.json({ ok: true, prompts: rows(prompts), results: rows(results) });
  });

  /** GET /api/agnb/backlinks — earned/swapped/claimed backlink ledger. */
  router.get("/agnb/backlinks", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, source_url, source_domain, source_da, target_url, anchor_text, kind,
             acquired_at, acquired_by, partner_email, reciprocal, status
      FROM agnb.backlinks
      ORDER BY acquired_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, backlinks: rows(result) });
  });

  /** GET /api/agnb/backlink-prospects — outreach candidate sites. */
  router.get("/agnb/backlink-prospects", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, source_domain, source_url, referring_to, competitor_name, domain_rank,
             discovered_via, status, outreach_subject, outreach_sent_at, notes, discovered_at
      FROM agnb.backlink_prospects
      ORDER BY domain_rank DESC NULLS LAST, discovered_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, prospects: rows(result) });
  });
}
