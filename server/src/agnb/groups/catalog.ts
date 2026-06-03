import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows, pgTextArray } from "../helpers.js";
import {
  scrapeSingleUrl,
  fetchProfilesFromSidecar,
  scraperConfigured,
} from "../lib/linkedin-sidecar.js";
import { jdSearch, jdDetail } from "../lib/justdial-sidecar.js";

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
        SELECT bucket_id, total_sent, total_replies, total_positive, total_meetings,
               compound_reply_rate, compound_positive_rate, campaigns_run
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

  /* ----------------------------------------------------------------------- *
   * Sidecar-backed writes — same-origin, user-triggered (assertBoardOrgAccess).
   * Ported from agnb app/.../api/agnb/{linkedin,leads/justdial}.
   * ----------------------------------------------------------------------- */

  /**
   * POST /api/agnb/linkedin/scrape — Body: { url }.
   * Forwards a single LinkedIn profile URL to the Python scraper sidecar's
   * /api/search. Returns immediately; caller follows with /linkedin/sync.
   */
  router.post("/agnb/linkedin/scrape", async (req, res) => {
    assertBoardOrgAccess(req);
    if (!scraperConfigured()) {
      return res.status(400).json({ ok: false, error: "LINKEDIN_SIDECAR_URL not set" });
    }
    const body = (req.body ?? {}) as { url?: string };
    const url = (body.url ?? "").trim();
    if (!/^https?:\/\/(www\.)?linkedin\.com\/in\//i.test(url)) {
      return res.status(400).json({
        ok: false,
        error: "URL must be https://www.linkedin.com/in/<vanity>/",
      });
    }
    try {
      const result = await scrapeSingleUrl(url);
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
      return res.json({ ok: true, url, started: true });
    } catch (e) {
      return res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  /**
   * POST /api/agnb/linkedin/sync — pull every profile from the scraper
   * sidecar's profiles.json mirror, normalize, and upsert into
   * agnb.linkedin_profiles keyed on source_url. Returns counts.
   */
  router.post("/agnb/linkedin/sync", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    if (!scraperConfigured()) {
      return res.status(400).json({ ok: false, error: "LINKEDIN_SIDECAR_URL not set" });
    }

    let raw: unknown[];
    try {
      raw = await fetchProfilesFromSidecar();
    } catch (e) {
      return res.status(502).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }

    const profiles = raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => {
        const jobs = Array.isArray(p.job_history) ? (p.job_history as Array<Record<string, unknown>>) : [];
        const current = jobs.find((j) => j.is_current) ?? jobs[0];
        return {
          source_url: String(p.source_url ?? ""),
          profile_id: (p.profile_id as string) ?? null,
          full_name: (p.full_name as string) ?? null,
          headline: (p.headline as string) ?? null,
          location: (p.location as string) ?? null,
          summary: (p.summary as string) ?? null,
          connections: (p.connections as string) ?? null,
          photo_url: (p.photo_url as string) ?? null,
          job_history: jobs,
          education: Array.isArray(p.education) ? p.education : [],
          skills: Array.isArray(p.skills) ? p.skills : [],
          current_company: (current?.company_name as string) ?? null,
          current_title: (current?.title as string) ?? null,
          raw: p,
          scraped_at: p.scraped_at ? new Date(Number(p.scraped_at) * 1000).toISOString() : null,
        };
      })
      .filter((r) => r.source_url);

    if (profiles.length === 0) {
      return res.json({ ok: true, synced: 0, sidecar_count: raw.length });
    }

    for (const p of profiles) {
      await db.execute(sql`
        INSERT INTO agnb.linkedin_profiles
          (source_url, profile_id, full_name, headline, location, summary, connections,
           photo_url, job_history, education, skills, current_company, current_title,
           raw, scraped_at, added_by)
        VALUES (
          ${p.source_url}, ${p.profile_id}, ${p.full_name}, ${p.headline}, ${p.location},
          ${p.summary}, ${p.connections}, ${p.photo_url},
          ${JSON.stringify(p.job_history)}::jsonb, ${JSON.stringify(p.education)}::jsonb,
          ${JSON.stringify(p.skills)}::jsonb, ${p.current_company}, ${p.current_title},
          ${JSON.stringify(p.raw)}::jsonb, ${p.scraped_at}, ${email}
        )
        ON CONFLICT (source_url) DO UPDATE SET
          profile_id = EXCLUDED.profile_id, full_name = EXCLUDED.full_name,
          headline = EXCLUDED.headline, location = EXCLUDED.location,
          summary = EXCLUDED.summary, connections = EXCLUDED.connections,
          photo_url = EXCLUDED.photo_url, job_history = EXCLUDED.job_history,
          education = EXCLUDED.education, skills = EXCLUDED.skills,
          current_company = EXCLUDED.current_company, current_title = EXCLUDED.current_title,
          raw = EXCLUDED.raw, scraped_at = EXCLUDED.scraped_at
      `);
    }

    res.json({ ok: true, synced: profiles.length, sidecar_count: raw.length });
  });

  /**
   * POST /api/agnb/leads/justdial — queue a JustDial scrape job. PURE DB.
   * Body: { category, city, max_pages? }
   */
  router.post("/agnb/leads/justdial", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as { category?: string; city?: string; max_pages?: number };
    const category = body.category?.trim();
    const city = body.city?.trim();
    const maxPages = Math.min(Math.max(Number(body.max_pages ?? 1), 1), 20);
    if (!category || !city) {
      return res.status(400).json({ ok: false, error: "category + city required" });
    }
    const result = await db.execute(sql`
      INSERT INTO agnb.justdial_jobs (category, city, max_pages, created_by)
      VALUES (${category}, ${city}, ${maxPages}, ${email})
      RETURNING id, category, city, max_pages, status, error, pages_scraped, leads_count,
                created_by, created_at, started_at, finished_at
    `);
    res.json({ ok: true, job: rows(result)[0] });
  });

  /**
   * POST /api/agnb/leads/justdial/run?id=<jobId> — drain one pending job:
   * search via sidecar → fan out detail pages when needed → upsert leads.
   * Idempotent on source_url. Marks job done|error|blocked.
   */
  router.post("/agnb/leads/justdial/run", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const job = rows<{ id: string; category: string; city: string; max_pages: number; status: string }>(
      await db.execute(sql`SELECT id, category, city, max_pages, status FROM agnb.justdial_jobs WHERE id = ${id}`)
    )[0];
    if (!job) return res.status(404).json({ ok: false, error: "job not found" });
    if (job.status === "running") return res.status(409).json({ ok: false, error: "already running" });

    await db.execute(sql`
      UPDATE agnb.justdial_jobs SET status = 'running', started_at = now() WHERE id = ${id}
    `);

    try {
      const search = await jdSearch({ category: job.category, city: job.city, maxPages: job.max_pages });
      if (search.blocked && search.listings.length === 0) {
        await db.execute(sql`
          UPDATE agnb.justdial_jobs
          SET status = 'blocked', error = 'sidecar reported blocked', finished_at = now()
          WHERE id = ${id}
        `);
        return res.status(502).json({ ok: false, error: "blocked" });
      }

      // sidecar v0.2: listing page already has phone + address + rating, so
      // upsert directly. Only fan out to /detail when basic listing missed
      // phone (rare) OR when caller requested deep enrichment.
      const ENRICH = false;
      let leadsCount = 0;

      for (const listing of search.listings) {
        const existing = rows<{ id: string }>(
          await db.execute(sql`SELECT id FROM agnb.justdial_leads WHERE source_url = ${listing.url} LIMIT 1`)
        )[0];
        if (existing) continue;

        let phone = listing.phone ?? null;
        let phoneSource = listing.phone_source ?? null;
        let address = listing.address ?? null;
        let rating = listing.rating ?? null;
        let website: string | null = null;
        let email: string | null = null;
        let reviewCount: number | null = null;
        let name = listing.name;

        const needDetail = ENRICH || !phone;
        if (needDetail) {
          const detail = await jdDetail(listing.url);
          if (!detail.blocked) {
            name = detail.name ?? name;
            phone = phone ?? detail.phone ?? null;
            phoneSource = phoneSource ?? (detail.phone_source ?? null);
            address = address ?? detail.address ?? null;
            rating = rating ?? detail.rating ?? null;
            website = detail.website ?? null;
            email = detail.email ?? null;
            reviewCount = detail.review_count ?? null;
          }
        }

        const phoneRevealedAt = phone ? new Date().toISOString() : null;
        await db.execute(sql`
          INSERT INTO agnb.justdial_leads
            (job_id, name, category, city, address, phone, phone_source, phone_revealed_at,
             rating, review_count, website, email, source_url)
          VALUES (
            ${id}, ${name}, ${job.category}, ${job.city}, ${address}, ${phone}, ${phoneSource},
            ${phoneRevealedAt}, ${rating}, ${reviewCount}, ${website}, ${email}, ${listing.url}
          )
          ON CONFLICT (source_url) DO UPDATE SET
            name = EXCLUDED.name, address = EXCLUDED.address, phone = EXCLUDED.phone,
            phone_source = EXCLUDED.phone_source, phone_revealed_at = EXCLUDED.phone_revealed_at,
            rating = EXCLUDED.rating, review_count = EXCLUDED.review_count,
            website = EXCLUDED.website, email = EXCLUDED.email
        `);
        leadsCount++;
      }

      await db.execute(sql`
        UPDATE agnb.justdial_jobs
        SET status = 'done', pages_scraped = ${search.pages_scraped}, leads_count = ${leadsCount},
            finished_at = now()
        WHERE id = ${id}
      `);
      return res.json({ ok: true, leads: leadsCount, pages: search.pages_scraped });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.execute(sql`
        UPDATE agnb.justdial_jobs SET status = 'error', error = ${msg}, finished_at = now() WHERE id = ${id}
      `);
      return res.status(500).json({ ok: false, error: msg });
    }
  });
}
