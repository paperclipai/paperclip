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
   * across weekly re-runs). Rows are tagged noticed_by='brand-monitor' (the sole
   * ingest source now that the standalone scraper is retired).
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
             'brand-monitor'
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

  /** POST /api/agnb/reviews/platforms — register a review platform to track. Body: { platform, profile_url, category? } */
  router.post("/agnb/reviews/platforms", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { platform?: string; profile_url?: string; category?: string };
    const platform = String(body.platform ?? "").trim();
    const profile_url = String(body.profile_url ?? "").trim();
    if (!platform || !profile_url) {
      res.status(400).json({ ok: false, error: "platform and profile_url required" });
      return;
    }
    // Idempotent: a platform may already be tracked (unique constraint
    // review_platforms_uniq). Upsert so re-registering just refreshes the URL.
    const result = await db.execute(sql`
      INSERT INTO agnb.review_platforms (platform, profile_url, category)
      VALUES (${platform}, ${profile_url}, ${body.category ?? null})
      ON CONFLICT (platform)
      DO UPDATE SET profile_url = EXCLUDED.profile_url, category = EXCLUDED.category
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id ?? null });
  });

  /** DELETE /api/agnb/reviews/platforms?id= — stop tracking a platform. */
  router.delete("/agnb/reviews/platforms", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) {
      res.status(400).json({ ok: false, error: "id required" });
      return;
    }
    await db.execute(sql`DELETE FROM agnb.review_platforms WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * POST /api/agnb/reviews/snapshot — Reviews Monitor agent updates a tracked
   * platform's current stats. Body: { platform, rating?, review_count?,
   * ranked_position? }. Updates by platform name (register it first via
   * POST /reviews/platforms); a snapshot for an unknown platform is a no-op.
   */
  router.post("/agnb/reviews/snapshot", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const platform = String(body.platform ?? "").trim();
    if (!platform) {
      res.status(400).json({ ok: false, error: "platform required" });
      return;
    }
    const rating = typeof body.rating === "number" ? body.rating : null;
    const reviewCount = typeof body.review_count === "number" ? body.review_count : null;
    const rankedPosition = typeof body.ranked_position === "number" ? body.ranked_position : null;
    const result = await db.execute(sql`
      UPDATE agnb.review_platforms
      SET rating = COALESCE(${rating}, rating),
          review_count = COALESCE(${reviewCount}, review_count),
          ranked_position = COALESCE(${rankedPosition}, ranked_position),
          last_checked_at = now()
      WHERE platform = ${platform}
      RETURNING id
    `);
    res.json({ ok: true, updated: rows(result).length });
  });

  /**
   * POST /api/agnb/reviews/log — Reviews Monitor agent ingests new review
   * entries. Body: { reviews: Array<{ platform, reviewer_handle?, rating?,
   * excerpt?, review_url?, collected_at? }> }. Idempotent on review_url when
   * present (no dupes across sweeps).
   */
  router.post("/agnb/reviews/log", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { reviews?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.reviews) ? body.reviews : [];
    if (list.length === 0) {
      res.status(400).json({ ok: false, error: "reviews[] required" });
      return;
    }
    let inserted = 0;
    for (const r of list) {
      const platform = String(r?.platform ?? "").trim();
      if (!platform) continue;
      const reviewerHandle = typeof r?.reviewer_handle === "string" ? r.reviewer_handle : null;
      const rating = typeof r?.rating === "number" ? r.rating : null;
      const excerpt = typeof r?.excerpt === "string" ? r.excerpt : null;
      const reviewUrl = typeof r?.review_url === "string" && r.review_url ? r.review_url : null;
      const collectedAt = typeof r?.collected_at === "string" ? r.collected_at : null;
      const result = await db.execute(sql`
        INSERT INTO agnb.review_log
          (platform, reviewer_handle, rating, excerpt, review_url, collected_at)
        SELECT ${platform}, ${reviewerHandle}, ${rating}, ${excerpt}, ${reviewUrl},
               COALESCE(${collectedAt}::timestamptz, now())
        WHERE ${reviewUrl}::text IS NULL
           OR NOT EXISTS (SELECT 1 FROM agnb.review_log WHERE review_url = ${reviewUrl})
        RETURNING id
      `);
      if (rows(result).length > 0) inserted++;
    }
    res.json({ ok: true, inserted });
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

  /** POST /api/agnb/sov — add a share-of-voice prompt. Body: { prompt, category? } */
  router.post("/agnb/sov", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { prompt?: string; category?: string };
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) {
      res.status(400).json({ ok: false, error: "prompt required" });
      return;
    }
    const result = await db.execute(sql`
      INSERT INTO agnb.sov_prompts (prompt, category)
      VALUES (${prompt}, ${body.category ?? null})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id ?? null });
  });

  /** DELETE /api/agnb/sov?id= — remove a prompt (and its results via FK cascade). */
  router.delete("/agnb/sov", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) {
      res.status(400).json({ ok: false, error: "id required" });
      return;
    }
    await db.execute(sql`DELETE FROM agnb.sov_prompts WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * POST /api/agnb/sov/results — ingest a batch of SoV run results (SoV Monitor
   * agent). Body: { results: Array<{ prompt_id, engine, brand_mentioned?,
   * position?, competitors_mentioned?: string[], ran_at? }> }. Each row records
   * one prompt run against one AI engine. Replaces the retired standalone
   * /inbound/sov/run engine — the agent now runs prompts and posts results here.
   */
  router.post("/agnb/sov/results", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { results?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.results) ? body.results : [];
    if (list.length === 0) {
      res.status(400).json({ ok: false, error: "results[] required" });
      return;
    }
    let inserted = 0;
    const skipped: string[] = [];
    for (const r of list) {
      const prompt_id = String(r?.prompt_id ?? "").trim();
      const engine = String(r?.engine ?? "").trim();
      if (!prompt_id || !engine) {
        skipped.push("missing prompt_id or engine");
        continue;
      }
      const competitorList = Array.isArray(r?.competitors_mentioned)
        ? (r.competitors_mentioned as unknown[]).map((c) => String(c))
        : null;
      // Serialize to a Postgres array literal and cast; binding a JS array param
      // directly to text[] is not supported by the query path.
      const competitorsLiteral = competitorList
        ? `{${competitorList.map((c) => `"${c.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`
        : null;
      const position = typeof r?.position === "number" ? r.position : null;
      const ranAt = typeof r?.ran_at === "string" ? r.ran_at : null;
      await db.execute(sql`
        INSERT INTO agnb.sov_results
          (prompt_id, engine, brand_mentioned, position, competitors_mentioned, ran_at)
        VALUES (
          ${prompt_id}, ${engine}, ${Boolean(r?.brand_mentioned)}, ${position},
          ${competitorsLiteral}::text[], COALESCE(${ranAt}::timestamptz, now())
        )
      `);
      inserted++;
    }
    res.json({ ok: true, inserted, skipped: skipped.length });
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

  /**
   * POST /api/agnb/backlink-prospects — Backlink Scout agent ingests discovered
   * outreach candidates. Body: { prospects: Array<{ source_domain, source_url?,
   * referring_to?, competitor_name?, domain_rank?, discovered_via? }> }.
   * Idempotent on source_domain (no dupes across discovery sweeps).
   */
  router.post("/agnb/backlink-prospects", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { prospects?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.prospects) ? body.prospects : [];
    if (list.length === 0) {
      res.status(400).json({ ok: false, error: "prospects[] required" });
      return;
    }
    let inserted = 0;
    for (const p of list) {
      const sourceDomain = String(p?.source_domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (!sourceDomain) continue;
      const sourceUrl = typeof p?.source_url === "string" ? p.source_url : null;
      const referringTo = typeof p?.referring_to === "string" ? p.referring_to : null;
      const competitorName = typeof p?.competitor_name === "string" ? p.competitor_name : null;
      const domainRank = typeof p?.domain_rank === "number" ? p.domain_rank : null;
      const discoveredVia = typeof p?.discovered_via === "string" ? p.discovered_via : "agent";
      const result = await db.execute(sql`
        INSERT INTO agnb.backlink_prospects
          (source_domain, source_url, referring_to, competitor_name, domain_rank, discovered_via, status)
        SELECT ${sourceDomain}, ${sourceUrl}, ${referringTo}, ${competitorName}, ${domainRank}, ${discoveredVia}, 'new'
        WHERE NOT EXISTS (SELECT 1 FROM agnb.backlink_prospects WHERE source_domain = ${sourceDomain})
        RETURNING id
      `);
      if (rows(result).length > 0) inserted++;
    }
    res.json({ ok: true, inserted });
  });

  /**
   * POST /api/agnb/backlinks — Backlink Scout agent ingests newly-earned links.
   * Body: { backlinks: Array<{ source_url, source_domain, target_url,
   * anchor_text?, kind?, source_da? }> }. Idempotent on source_url.
   */
  router.post("/agnb/backlinks", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { backlinks?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.backlinks) ? body.backlinks : [];
    if (list.length === 0) {
      res.status(400).json({ ok: false, error: "backlinks[] required" });
      return;
    }
    let inserted = 0;
    for (const b of list) {
      const sourceUrl = String(b?.source_url ?? "").trim();
      const sourceDomain = String(b?.source_domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      const targetUrl = String(b?.target_url ?? "").trim();
      if (!sourceUrl || !sourceDomain || !targetUrl) continue;
      const anchorText = typeof b?.anchor_text === "string" ? b.anchor_text : null;
      const kind = typeof b?.kind === "string" ? b.kind : "earned";
      const sourceDa = typeof b?.source_da === "number" ? b.source_da : null;
      const result = await db.execute(sql`
        INSERT INTO agnb.backlinks
          (source_url, source_domain, target_url, anchor_text, kind, source_da, status)
        SELECT ${sourceUrl}, ${sourceDomain}, ${targetUrl}, ${anchorText}, ${kind}, ${sourceDa}, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM agnb.backlinks WHERE source_url = ${sourceUrl})
        RETURNING id
      `);
      if (rows(result).length > 0) inserted++;
    }
    res.json({ ok: true, inserted });
  });
}
