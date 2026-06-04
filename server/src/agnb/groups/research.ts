import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: research (SEO / content research).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{bofu,competitors,content,idea-inbox,rss-feeds}.
 *
 * Pure-DB reads + CRUD only. The crawl/scrape/LLM-backed routes (sitemap
 * scraping, content-gap analysis via Gemini, RSS sync, content audit) live in
 * separate AGNB routes and are NOT ported here → Phase 5 (worker), left
 * cross-origin in the UI. competitor_blogs / bofu_position_log /
 * content_audit_issues are only touched by those scraper/analysis routes, so
 * they are intentionally not queried here.
 */
export function registerResearch(router: Router, db: Db) {
  // ----------------------------------------------------------------------- bofu

  /** GET /api/agnb/bofu — BoFu page tracker. */
  router.get("/agnb/bofu", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, url, title, competitor, content_type, primary_keyword, status,
             current_rank, monthly_traffic, monthly_signups, last_checked_at, created_at
      FROM agnb.bofu_pages
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, pages: rows(result) });
  });

  /** POST /api/agnb/bofu — add a BoFu page. Body: { url, title, content_type?, competitor?, primary_keyword?, status? } */
  router.post("/agnb/bofu", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.url?.trim() || !body.title?.trim()) {
      return res.status(400).json({ ok: false, error: "url + title required" });
    }
    const result = await db.execute(sql`
      INSERT INTO agnb.bofu_pages (url, title, content_type, competitor, primary_keyword, status, created_by)
      VALUES (${body.url.trim()}, ${body.title.trim()}, ${body.content_type ?? "comparison"},
              ${body.competitor ?? null}, ${body.primary_keyword ?? null}, ${body.status ?? "planned"}, ${email})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id });
  });

  /** PATCH /api/agnb/bofu?id= — update fields. */
  router.patch("/agnb/bofu", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["url", "title", "content_type", "competitor", "primary_keyword", "status", "current_rank", "monthly_traffic"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`UPDATE agnb.bofu_pages SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/bofu?id= */
  router.delete("/agnb/bofu", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.bofu_pages WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * POST /api/agnb/bofu/snapshot — BoFu Rank Monitor agent records current SERP
   * + traffic metrics for a tracked page. Body: { url, current_rank?,
   * monthly_traffic?, monthly_signups? }. Updates by url (add the page first via
   * POST /bofu); a snapshot for an unknown url is a no-op.
   */
  router.post("/agnb/bofu/snapshot", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = String(body.url ?? "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "url required" });
    const currentRank = typeof body.current_rank === "number" ? body.current_rank : null;
    const monthlyTraffic = typeof body.monthly_traffic === "number" ? body.monthly_traffic : null;
    const monthlySignups = typeof body.monthly_signups === "number" ? body.monthly_signups : null;
    const result = await db.execute(sql`
      UPDATE agnb.bofu_pages
      SET current_rank = COALESCE(${currentRank}, current_rank),
          monthly_traffic = COALESCE(${monthlyTraffic}, monthly_traffic),
          monthly_signups = COALESCE(${monthlySignups}, monthly_signups),
          last_checked_at = now()
      WHERE url = ${url}
      RETURNING id
    `);
    res.json({ ok: true, updated: rows(result).length });
  });

  // ---------------------------------------------------------------- competitors

  /** GET /api/agnb/competitors — competitors + content gaps. */
  router.get("/agnb/competitors", async (req, res) => {
    assertBoardOrgAccess(req);
    const [competitors, gaps] = await Promise.all([
      db.execute(sql`
        SELECT id, name, domain, sitemap_url, status, last_scraped_at, last_error, total_blogs_seen, created_at
        FROM agnb.competitors
        ORDER BY created_at DESC
      `),
      db.execute(sql`
        SELECT id, topic, gap_score, competitor_count, our_coverage_count, suggested_keywords, status, suggestion_type, created_at
        FROM agnb.content_gaps
        ORDER BY gap_score DESC
        LIMIT 200
      `),
    ]);
    res.json({ ok: true, competitors: rows(competitors), gaps: rows(gaps) });
  });

  /** POST /api/agnb/competitors — add a competitor. Body: { name, domain, sitemap_url, blog_path_pattern? } */
  router.post("/agnb/competitors", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as Record<string, any>;
    const name = body.name?.trim();
    const domain = body.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const sitemap_url = body.sitemap_url?.trim();
    const blog_path_pattern = body.blog_path_pattern?.trim() || "/blog/";

    if (!name || !domain || !sitemap_url) {
      return res.status(400).json({ ok: false, error: "name, domain, sitemap_url required" });
    }
    if (!/^https?:\/\//i.test(sitemap_url)) {
      return res.status(400).json({ ok: false, error: "sitemap_url must start with http(s)://" });
    }

    try {
      const result = await db.execute(sql`
        INSERT INTO agnb.competitors (name, domain, sitemap_url, blog_path_pattern, status)
        VALUES (${name}, ${domain}, ${sitemap_url}, ${blog_path_pattern}, 'active')
        RETURNING *
      `);
      res.json({ ok: true, row: rows(result)[0] ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key/i.test(msg)) {
        return res.status(409).json({ ok: false, error: `domain "${domain}" already added` });
      }
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  /** PATCH /api/agnb/competitors?id= — toggle status / edit. */
  router.patch("/agnb/competitors", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;

    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if (typeof body.status === "string" && ["active", "paused"].includes(body.status)) sets.push(sql`status = ${body.status}`);
    if (typeof body.sitemap_url === "string") sets.push(sql`sitemap_url = ${body.sitemap_url}`);
    if (typeof body.blog_path_pattern === "string") sets.push(sql`blog_path_pattern = ${body.blog_path_pattern}`);

    await db.execute(sql`UPDATE agnb.competitors SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/competitors?id= */
  router.delete("/agnb/competitors", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.competitors WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * POST /api/agnb/competitors/scan — Competitor Watcher agent records a scrape
   * result for one competitor. Body: { domain, total_blogs_seen?, status?,
   * last_error? }. Updates by domain (add it first via POST /competitors); a
   * scan for an unknown domain is a no-op.
   */
  router.post("/agnb/competitors/scan", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const domain = String(body.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!domain) return res.status(400).json({ ok: false, error: "domain required" });
    const totalBlogs = typeof body.total_blogs_seen === "number" ? body.total_blogs_seen : null;
    const status = typeof body.status === "string" && ["active", "paused", "error"].includes(body.status) ? body.status : null;
    const lastError = typeof body.last_error === "string" ? body.last_error : null;
    const result = await db.execute(sql`
      UPDATE agnb.competitors
      SET total_blogs_seen = COALESCE(${totalBlogs}, total_blogs_seen),
          status = COALESCE(${status}, status),
          last_error = ${lastError},
          last_scraped_at = now()
      WHERE domain = ${domain}
      RETURNING id
    `);
    res.json({ ok: true, updated: rows(result).length });
  });

  /**
   * POST /api/agnb/content-gaps — Competitor Watcher agent ingests computed
   * content gaps. Body: { gaps: Array<{ topic, gap_score, competitor_count?,
   * our_coverage_count?, suggested_keywords?: string[], suggestion_type? }> }.
   * Idempotent on topic (a gap already tracked is skipped, not duplicated).
   */
  router.post("/agnb/content-gaps", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { gaps?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.gaps) ? body.gaps : [];
    if (list.length === 0) return res.status(400).json({ ok: false, error: "gaps[] required" });
    let inserted = 0;
    for (const g of list) {
      const topic = String(g?.topic ?? "").trim();
      if (!topic) continue;
      const gapScore = typeof g?.gap_score === "number" ? g.gap_score : 0;
      const competitorCount = typeof g?.competitor_count === "number" ? g.competitor_count : 0;
      const ourCoverage = typeof g?.our_coverage_count === "number" ? g.our_coverage_count : 0;
      const suggestionType = typeof g?.suggestion_type === "string" ? g.suggestion_type : "gap";
      const keywords = Array.isArray(g?.suggested_keywords)
        ? (g.suggested_keywords as unknown[]).map((k) => String(k))
        : null;
      const keywordsLiteral = keywords
        ? `{${keywords.map((k) => `"${k.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`
        : null;
      const result = await db.execute(sql`
        INSERT INTO agnb.content_gaps
          (topic, gap_score, competitor_count, our_coverage_count, suggested_keywords, status, suggestion_type)
        SELECT ${topic}, ${gapScore}, ${competitorCount}, ${ourCoverage},
               ${keywordsLiteral}::text[], 'identified', ${suggestionType}
        WHERE NOT EXISTS (SELECT 1 FROM agnb.content_gaps WHERE topic = ${topic})
        RETURNING id
      `);
      if (rows(result).length > 0) inserted++;
    }
    res.json({ ok: true, inserted });
  });

  // -------------------------------------------------------------------- content
  // NOTE: /content (content_briefs) is also referenced by agnbBlog.ts, which is
  // out of scope and untouched. Only the research client's brief CRUD lives here.

  /** GET /api/agnb/content — content briefs (editorial calendar by stage). */
  router.get("/agnb/content", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, title, content_type, stage, primary_keyword, buyer_phrase, target_url,
             published_at, refresh_due_at, created_at, created_by
      FROM agnb.content_briefs
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, briefs: rows(result) });
  });

  /** POST /api/agnb/content — create a brief. Body: { title, content_type?, stage?, primary_keyword?, buyer_phrase? } */
  router.post("/agnb/content", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.title?.trim()) return res.status(400).json({ ok: false, error: "title required" });
    const result = await db.execute(sql`
      INSERT INTO agnb.content_briefs (title, content_type, stage, primary_keyword, buyer_phrase, created_by)
      VALUES (${body.title.trim()}, ${body.content_type ?? "comparison"}, ${body.stage ?? "idea"},
              ${body.primary_keyword ?? null}, ${body.buyer_phrase ?? null}, ${email})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id });
  });

  /** PATCH /api/agnb/content?id= — update stage/fields. */
  router.patch("/agnb/content", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["title", "content_type", "stage", "primary_keyword", "buyer_phrase", "target_url"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`UPDATE agnb.content_briefs SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/content?id= */
  router.delete("/agnb/content", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.content_briefs WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------ idea-inbox

  /** GET /api/agnb/idea-inbox — list blog ideas. */
  router.get("/agnb/idea-inbox", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, raw_text, source, status, related_topic, notes, created_by, created_at
      FROM agnb.blog_ideas
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, ideas: rows(result) });
  });

  /** POST /api/agnb/idea-inbox — capture a new idea. Body: { raw_text, source?, notes? } */
  router.post("/agnb/idea-inbox", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, any>;
    const raw_text = String(body.raw_text ?? "").trim();
    if (!raw_text) return res.status(400).json({ ok: false, error: "raw_text required" });
    const result = await db.execute(sql`
      INSERT INTO agnb.blog_ideas (raw_text, source, notes, status, created_by)
      VALUES (${raw_text}, ${body.source ?? "manual"}, ${body.notes ?? null}, 'inbox', ${email})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id });
  });

  /** PATCH /api/agnb/idea-inbox?id= — update status (promote/trash) or fields. */
  router.patch("/agnb/idea-inbox", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["status", "related_topic", "notes"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`UPDATE agnb.blog_ideas SET ${sql.join(sets, sql`, `)} WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/idea-inbox?id= */
  router.delete("/agnb/idea-inbox", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.blog_ideas WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------- rss-feeds

  /** GET /api/agnb/rss-feeds — feeds + recent items. */
  router.get("/agnb/rss-feeds", async (req, res) => {
    assertBoardOrgAccess(req);
    const [feeds, items] = await Promise.all([
      db.execute(sql`
        SELECT id, name, url, category, status, last_synced_at, last_error, items_count
        FROM agnb.rss_feeds
        ORDER BY name
      `),
      db.execute(sql`
        SELECT id, feed_id, feed_name, title, url, summary, published_at, fetched_at
        FROM agnb.rss_items
        ORDER BY published_at DESC
        LIMIT 100
      `),
    ]);
    res.json({ ok: true, feeds: rows(feeds), items: rows(items) });
  });

  /** POST /api/agnb/rss-feeds — add a feed. Body: { name, url, category? } */
  router.post("/agnb/rss-feeds", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.name?.trim() || !body.url?.trim()) {
      return res.status(400).json({ ok: false, error: "name + url required" });
    }
    try {
      const result = await db.execute(sql`
        INSERT INTO agnb.rss_feeds (name, url, category, status)
        VALUES (${body.name.trim()}, ${body.url.trim()}, ${body.category ?? "general"}, 'active')
        RETURNING *
      `);
      res.json({ ok: true, row: rows(result)[0] ?? null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key/i.test(msg)) return res.status(409).json({ ok: false, error: "feed url already added" });
      return res.status(500).json({ ok: false, error: msg });
    }
  });

  /** PATCH /api/agnb/rss-feeds?id= — update status. */
  router.patch("/agnb/rss-feeds", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    await db.execute(sql`
      UPDATE agnb.rss_feeds SET status = ${body.status ?? null}, updated_at = ${new Date().toISOString()}
      WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/rss-feeds?id= */
  router.delete("/agnb/rss-feeds", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.rss_feeds WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // PHASE 5 (worker, left cross-origin in UI):
  //  - competitor sitemap scraping (internal/sitemap-scraper) → competitor_blogs
  //  - content-gap analysis via Gemini (internal/gap-analyzer) → content_gaps
  //  - content audit (internal/content-audit) → content_audit_issues
  //  - RSS feed sync (fetches + parses external feeds) → rss_items
  //  - BoFu SERP position tracking (inbound/bofu/sync) → bofu_position_log
}
