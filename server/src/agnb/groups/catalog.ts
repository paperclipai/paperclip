import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows, pgTextArray } from "../helpers.js";

/**
 * AGNB group: catalog reads (targeting, studio personas/products, justdial jobs,
 * linkedin profiles, experiment buckets + rollup, icps).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{targeting,studio,leads,linkedin,buckets,icps}.
 * Pure-DB writes (icps, targeting, buckets POST) are ported here. Write/create
 * routes that hit external APIs/sidecars (Rocket persona/product sync, JustDial
 * scraper, LinkedIn scraper) stay cross-origin in the UI → Phase 5.
 */
export function registerCatalog(router: Router, db: Db) {
  /** GET /api/agnb/targeting — saved Rocket targeting queries. */
  router.get("/agnb/targeting", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, query, notes, tags, last_run_at, last_lead_count, created_at, created_by
      FROM agnb.saved_targetings
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ ok: true, targetings: rows(result) });
  });

  /** GET /api/agnb/studio/personas — Rocket buyer personas. */
  router.get("/agnb/studio/personas", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, title
      FROM agnb.rocket_personas
      ORDER BY name
    `);
    res.json({ ok: true, personas: rows(result) });
  });

  /** GET /api/agnb/studio/products — Rocket products. */
  router.get("/agnb/studio/products", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, description
      FROM agnb.rocket_products
      ORDER BY name
    `);
    res.json({ ok: true, products: rows(result) });
  });

  /** GET /api/agnb/leads/justdial — JustDial scrape jobs (paged). */
  router.get("/agnb/leads/justdial", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, category, city, max_pages, status, error, pages_scraped, leads_count,
             created_by, created_at, started_at, finished_at
      FROM agnb.justdial_jobs
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json({ ok: true, jobs: rows(result) });
  });

  /** GET /api/agnb/linkedin — scraped LinkedIn profiles (mirror). */
  router.get("/agnb/linkedin", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, source_url, full_name, headline, location, current_company, current_title,
             photo_url, scraped_at, added_at
      FROM agnb.linkedin_profiles
      ORDER BY added_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, profiles: rows(result) });
  });

  /** GET /api/agnb/buckets — experiment buckets + rollup metrics + ICP names. */
  router.get("/agnb/buckets", async (req, res) => {
    assertBoardOrgAccess(req);
    // bucket_rollup view recreated via agnb migration 0001. Rollup metrics
    // populate once campaign_drafts links buckets to rocket_campaigns (Phase 5 sync).
    const [bucketsResult, rollupResult, icpsResult] = await Promise.all([
      db.execute(sql`
        SELECT id, name, icp_id, status, target_reply_rate, estimated_leads, created_at
        FROM agnb.experiment_buckets
        ORDER BY created_at DESC
        LIMIT 500
      `),
      db.execute(sql`
        SELECT bucket_id, total_sent, total_replies, total_meetings,
               compound_reply_rate, campaigns_run
        FROM agnb.bucket_rollup
      `),
      db.execute(sql`
        SELECT id, name, tier
        FROM agnb.icps
      `),
    ]);
    const icpById = new Map(
      rows<{ id: string; name: string; tier: string }>(icpsResult).map((i) => [i.id, i])
    );
    const rollupByBucket = new Map(
      rows<{ bucket_id: string }>(rollupResult).map((r) => [r.bucket_id, r])
    );
    const out = rows<{ id: string; icp_id: string | null }>(bucketsResult).map((b) => ({
      ...b,
      icp_name: b.icp_id ? icpById.get(b.icp_id)?.name ?? null : null,
      rollup: rollupByBucket.get(b.id) ?? null,
    }));
    res.json({ ok: true, buckets: out });
  });

  /** GET /api/agnb/icps — ICP definitions. */
  router.get("/agnb/icps", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, industries, company_size_min, company_size_max, regions, functions,
             seniority, tier, signals, created_at
      FROM agnb.icps
      ORDER BY created_at DESC
    `);
    res.json({ ok: true, icps: rows(result) });
  });

  /**
   * POST /api/agnb/icps — create an ICP definition. PURE DB.
   * Body: { name, tier?, industries?, regions?, functions?, seniority?, signals?,
   *         company_size_min?, company_size_max? }
   */
  router.post("/agnb/icps", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      name?: string;
      tier?: string;
      industries?: string[];
      regions?: string[];
      functions?: string[];
      seniority?: string[];
      signals?: Record<string, unknown>;
      company_size_min?: number | null;
      company_size_max?: number | null;
    };
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const industries = Array.isArray(body.industries) ? body.industries : [];
    const regions = Array.isArray(body.regions) ? body.regions : [];
    const functions = Array.isArray(body.functions) ? body.functions : [];
    const seniority = Array.isArray(body.seniority) ? body.seniority : [];
    const tier = ["now", "later", "monitor"].includes(body.tier ?? "") ? body.tier! : "monitor";
    const signals = JSON.stringify(body.signals && typeof body.signals === "object" ? body.signals : {});
    const sizeMin = body.company_size_min == null ? null : Number(body.company_size_min);
    const sizeMax = body.company_size_max == null ? null : Number(body.company_size_max);

    const result = await db.execute(sql`
      INSERT INTO agnb.icps
        (name, industries, company_size_min, company_size_max, regions, functions,
         seniority, tier, signals, created_by)
      VALUES
        (${name}, ${pgTextArray(industries)}::text[], ${sizeMin}, ${sizeMax}, ${pgTextArray(regions)}::text[],
         ${pgTextArray(functions)}::text[], ${pgTextArray(seniority)}::text[], ${tier}, ${signals}::jsonb, ${email})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id });
  });

  /**
   * POST /api/agnb/targeting — save a targeting query. PURE DB.
   * Body: { name, query, notes?, tags? }
   */
  router.post("/agnb/targeting", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as { name?: string; query?: string; notes?: string; tags?: string[] };
    const name = String(body.name ?? "").trim();
    const query = String(body.query ?? "").trim();
    if (!name || !query) return res.status(400).json({ ok: false, error: "name + query required" });

    const tags = Array.isArray(body.tags) ? body.tags : null;
    const notes = body.notes ?? null;
    const result = await db.execute(sql`
      INSERT INTO agnb.saved_targetings (name, query, notes, tags, created_by)
      VALUES (${name}, ${query}, ${notes}, ${tags === null ? null : sql`${pgTextArray(tags)}::text[]`}, ${email})
      RETURNING id
    `);
    res.json({ ok: true, id: rows<{ id: string }>(result)[0]?.id });
  });

  /**
   * POST /api/agnb/buckets — create an experiment bucket. PURE DB.
   * Body: { name, icp_id?, rocket_persona_id?, rocket_product_id?, targeting_filters?,
   *         target_reply_rate?, min_sends_before_judging?, estimated_leads?, estimated_at?, channel? }
   * Also writes a best-effort entity_audit row (mirrors AGNB logEntityChange).
   */
  router.post("/agnb/buckets", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      name?: string;
      icp_id?: string | null;
      rocket_persona_id?: string | null;
      rocket_product_id?: string | null;
      targeting_filters?: Record<string, unknown>;
      target_reply_rate?: number;
      min_sends_before_judging?: number;
      estimated_leads?: number | null;
      estimated_at?: string | null;
      channel?: string;
    };
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const channel = ["email", "linkedin", "finn_voice", "sms"].includes(body.channel ?? "")
      ? body.channel! : "email";
    const icpId = body.icp_id ?? null;
    const targetingFilters = JSON.stringify(
      body.targeting_filters && typeof body.targeting_filters === "object" ? body.targeting_filters : {}
    );
    const targetReplyRate = body.target_reply_rate != null ? Number(body.target_reply_rate) : 0.03;
    const minSends = body.min_sends_before_judging != null ? Number(body.min_sends_before_judging) : 1000;
    const estimatedLeads = body.estimated_leads != null ? Number(body.estimated_leads) : null;

    const result = await db.execute(sql`
      INSERT INTO agnb.experiment_buckets
        (name, icp_id, rocket_persona_id, rocket_product_id, targeting_filters,
         target_reply_rate, min_sends_before_judging, estimated_leads, estimated_at,
         status, channel, owner_email, created_by)
      VALUES
        (${name}, ${icpId}, ${body.rocket_persona_id ?? null}, ${body.rocket_product_id ?? null},
         ${targetingFilters}::jsonb, ${targetReplyRate}, ${minSends}, ${estimatedLeads},
         ${body.estimated_at ?? null}, 'proposed', ${channel}, ${email}, ${email})
      RETURNING id
    `);
    const id = rows<{ id: string }>(result)[0]?.id;

    // Best-effort audit (mirrors AGNB logEntityChange) — never break the write.
    try {
      const diff = JSON.stringify({ after: { name, channel, icp_id: icpId } });
      await db.execute(sql`
        INSERT INTO agnb.entity_audit (entity_type, entity_id, action, diff, actor_email)
        VALUES ('bucket', ${id}, 'create', ${diff}::jsonb, ${email})
      `);
    } catch {
      /* swallow */
    }

    res.json({ ok: true, id });
  });
}
