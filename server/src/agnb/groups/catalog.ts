import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: catalog reads (targeting, studio personas/products, justdial jobs,
 * linkedin profiles, experiment buckets + rollup, icps).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{targeting,studio,leads,linkedin,buckets,icps}.
 * Write/create routes hit external APIs/sidecars (Rocket sync, JustDial scraper,
 * LinkedIn scraper) → Phase 5, left cross-origin in the UI.
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
}
