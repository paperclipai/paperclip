import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows, pgTextArray } from "../helpers.js";

/**
 * AGNB group: revenue (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{attribution,crm-hygiene,
 * demos,funnel,win-loss,invoices}.
 *
 * Pure-DB GET reads only. The following stay cross-origin (Phase 5 / worker):
 *  - attribution/gemini-rematch + attribution/rematch (Gemini LLM)
 *  - invoices/create + invoices/[id]/refresh (Razorpay external API)
 *  - win-loss POST/PATCH/DELETE + win-loss/[id]/analyze (writes/LLM)
 */

/** Standard HubSpot stage probability ladder (env override existed in AGNB). */
const DEFAULT_PROBS: Record<string, number> = {
  appointmentscheduled: 0.2,
  qualifiedtobuy: 0.4,
  presentationscheduled: 0.6,
  decisionmakerboughtin: 0.8,
  contractsent: 0.9,
  closedwon: 1.0,
  closedlost: 0.0,
};

function getProbs(): Record<string, number> {
  try {
    const env = process.env.HUBSPOT_STAGE_PROBABILITIES;
    if (env) return { ...DEFAULT_PROBS, ...JSON.parse(env) };
  } catch {
    /* ignore */
  }
  return DEFAULT_PROBS;
}

/** Monte Carlo: N trials of Σ amount × Bernoulli(p) over open deals → p5/p50/p95. */
function simulate(open: Array<{ amt: number; p: number }>): { p5: number; p50: number; p95: number } | null {
  if (open.length === 0) return null;
  const N = 2000;
  const totals = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    let t = 0;
    for (const d of open) if (Math.random() < d.p) t += d.amt;
    totals[i] = t;
  }
  totals.sort((a, b) => a - b);
  return {
    p5: Math.round(totals[Math.floor(0.05 * N)]),
    p50: Math.round(totals[Math.floor(0.5 * N)]),
    p95: Math.round(totals[Math.floor(0.95 * N)]),
  };
}

export function registerRevenue(router: Router, db: Db) {
  /**
   * GET /api/agnb/forecast — pipeline forecast per bucket.
   * Ported from agnb app/all-gas-no-brakes/api/agnb/forecast. Fully DB-backed:
   * joins agnb.hubspot_deals → agnb.attribution_events (external_id → bucket_id)
   * → agnb.experiment_buckets for names. weighted = Σ(amount × stage prob);
   * Monte Carlo CI per bucket + global. Shape: { ok, probs_used, totals,
   * global_ci, forecast, note }.
   */
  router.get("/agnb/forecast", async (req, res) => {
    assertBoardOrgAccess(req);
    const probs = getProbs();

    const dealsR = await db.execute(sql`
      SELECT id, dealstage, amount_usd
      FROM agnb.hubspot_deals
      WHERE dealstage IS NOT NULL
    `);
    const deals = rows<{ id: string; dealstage: string | null; amount_usd: number | string | null }>(dealsR);

    // Match deal id → bucket via attribution_events (source = hubspot).
    const dealIds = deals.map((d) => d.id);
    const attrByDeal = new Map<string, string | null>();
    if (dealIds.length > 0) {
      const attrR = await db.execute(sql`
        SELECT external_id, bucket_id
        FROM agnb.attribution_events
        WHERE source = 'hubspot' AND external_id = ANY(${pgTextArray(dealIds)}::text[])
      `);
      for (const a of rows<{ external_id: string; bucket_id: string | null }>(attrR)) {
        attrByDeal.set(a.external_id, a.bucket_id ?? null);
      }
    }

    type Agg = { weighted: number; total: number; deals: number; won: number; won_value: number; openDeals: Array<{ amt: number; p: number }> };
    const perBucket = new Map<string, Agg>();
    for (const d of deals) {
      const stage = String(d.dealstage ?? "").toLowerCase();
      const prob = probs[stage] ?? 0;
      const amount = Number(d.amount_usd ?? 0);
      const weighted = amount * prob;
      const key = attrByDeal.get(d.id) ?? "unattributed";
      const cur = perBucket.get(key) ?? { weighted: 0, total: 0, deals: 0, won: 0, won_value: 0, openDeals: [] };
      cur.weighted += weighted;
      cur.total += amount;
      cur.deals += 1;
      if (stage.includes("closedwon")) {
        cur.won += 1;
        cur.won_value += amount;
      } else if (!stage.includes("closedlost") && amount > 0 && prob > 0 && prob < 1) {
        cur.openDeals.push({ amt: amount, p: prob });
      }
      perBucket.set(key, cur);
    }

    // Resolve bucket names.
    const bucketIds = Array.from(perBucket.keys()).filter((k) => k !== "unattributed");
    const nameMap = new Map<string, string>();
    if (bucketIds.length > 0) {
      const nameR = await db.execute(sql`
        SELECT id, name FROM agnb.experiment_buckets WHERE id = ANY(${pgTextArray(bucketIds)}::uuid[])
      `);
      for (const r of rows<{ id: string; name: string }>(nameR)) nameMap.set(r.id, r.name);
    }

    const forecast = Array.from(perBucket.entries())
      .map(([k, v]) => {
        const ci = simulate(v.openDeals);
        return {
          bucket_id: k === "unattributed" ? null : k,
          bucket_name: k === "unattributed" ? null : nameMap.get(k) ?? null,
          weighted_forecast_usd: Math.round(v.weighted),
          total_pipeline_usd: Math.round(v.total),
          deals_in_pipeline: v.deals,
          deals_won: v.won,
          won_revenue_usd: Math.round(v.won_value),
          ci_p5: ci?.p5 ?? null,
          ci_p50: ci?.p50 ?? null,
          ci_p95: ci?.p95 ?? null,
        };
      })
      .sort((a, b) => b.weighted_forecast_usd - a.weighted_forecast_usd);

    const allOpen: Array<{ amt: number; p: number }> = [];
    for (const v of perBucket.values()) for (const d of v.openDeals) allOpen.push(d);
    const globalCi = simulate(allOpen);

    const totals = forecast.reduce(
      (acc, b) => ({
        weighted: acc.weighted + b.weighted_forecast_usd,
        total: acc.total + b.total_pipeline_usd,
        won: acc.won + b.won_revenue_usd,
        deals: acc.deals + b.deals_in_pipeline,
      }),
      { weighted: 0, total: 0, won: 0, deals: 0 },
    );

    res.json({
      ok: true,
      probs_used: probs,
      totals,
      global_ci: globalCi,
      forecast,
      note: deals.length === 0 ? "no hubspot_deals in mirror — run pipeline-sync after HUBSPOT_API_KEY set" : null,
    });
  });

  /** GET /api/agnb/attribution — match-rate counts + recent unmatched events. */
  router.get("/agnb/attribution", async (req, res) => {
    assertBoardOrgAccess(req);
    const [unmatchedCount, matchedCount, recent] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM agnb.attribution_events
        WHERE match_method = 'unmatched'
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM agnb.attribution_events
        WHERE match_method <> 'unmatched'
      `),
      db.execute(sql`
        SELECT id, source, event_type, email, contact_name, amount_usd, occurred_at, match_method
        FROM agnb.attribution_events
        WHERE match_method = 'unmatched'
        ORDER BY occurred_at DESC
        LIMIT 20
      `),
    ]);
    res.json({
      ok: true,
      unmatched: rows<{ count: number }>(unmatchedCount)[0]?.count ?? 0,
      matched: rows<{ count: number }>(matchedCount)[0]?.count ?? 0,
      recent_unmatched: rows(recent),
    });
  });

  /** GET /api/agnb/crm-hygiene — unresolved CRM data-quality issues. */
  router.get("/agnb/crm-hygiene", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, hubspot_object_type, hubspot_object_id, hubspot_object_name,
             issue_type, severity, details, detected_at, resolved_at
      FROM agnb.crm_hygiene_issues
      WHERE resolved_at IS NULL
      ORDER BY severity DESC, detected_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, issues: rows(result) });
  });

  /** GET /api/agnb/demos — Cal.com bookings mirror (upcoming + past 30). */
  router.get("/agnb/demos", async (req, res) => {
    assertBoardOrgAccess(req);
    const now = new Date().toISOString();
    const [upcoming, past] = await Promise.all([
      db.execute(sql`
        SELECT id, uid, title, status, start_at, end_at, attendee_email, attendee_name, event_type_slug
        FROM agnb.cal_bookings
        WHERE start_at >= ${now}
        ORDER BY start_at ASC
        LIMIT 30
      `),
      db.execute(sql`
        SELECT id, uid, title, status, start_at, end_at, attendee_email, attendee_name, event_type_slug
        FROM agnb.cal_bookings
        WHERE start_at < ${now}
        ORDER BY start_at DESC
        LIMIT 30
      `),
    ]);
    res.json({ ok: true, upcoming: rows(upcoming), past: rows(past) });
  });

  /**
   * GET /api/agnb/funnel — latest conversion funnel from funnel_snapshots.
   * (Live PostHog traffic-sources/top-pages were best-effort in AGNB; the
   * PostHog integration is an external call → Phase 5. Returns empty
   * sources/pages here so the UI shape is preserved.)
   */
  router.get("/agnb/funnel", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT funnel_key, step_name, step_order, count, snapshot_date
      FROM agnb.funnel_snapshots
      ORDER BY snapshot_date DESC, step_order ASC
      LIMIT 200
    `);
    const data = rows<{
      funnel_key: string;
      step_name: string;
      step_order: number;
      count: number;
      snapshot_date: string;
    }>(result);
    const latestDate = data[0]?.snapshot_date ?? null;
    const latest = data
      .filter((r) => r.snapshot_date === latestDate)
      .sort((a, b) => a.step_order - b.step_order);
    const first = latest[0]?.count ?? 0;
    const steps = latest.map((r) => ({
      step: r.step_name,
      count: r.count,
      conversion_pct: first > 0 ? (r.count / first) * 100 : 0,
    }));
    // PHASE 5: live PostHog traffic-sources/top-pages (getTrafficSources/
    // getTopPages) are external API calls — return empty to preserve UI shape.
    res.json({ ok: true, snapshot_date: latestDate, steps, sources: [], pages: [] });
  });

  /** GET /api/agnb/win-loss?outcome= — win/loss interviews (read-only). */
  router.get("/agnb/win-loss", async (req, res) => {
    assertBoardOrgAccess(req);
    const outcome = typeof req.query.outcome === "string" ? req.query.outcome : null;
    const base = sql`
      SELECT id, deal_id, customer_name, outcome, interview_date, contact_name, contact_title,
             summary, top_reasons, decision_makers, competitors_considered, feature_requests,
             raw_quote, raw_transcript, tags, analysis_status, created_at
      FROM agnb.win_loss_interviews
    `;
    const result =
      outcome && outcome !== "all"
        ? await db.execute(sql`${base} WHERE outcome = ${outcome} ORDER BY interview_date DESC LIMIT 200`)
        : await db.execute(sql`${base} ORDER BY interview_date DESC LIMIT 200`);
    res.json({ ok: true, interviews: rows(result) });
  });

  /** GET /api/agnb/invoices?status=&q= — Razorpay top-up invoices (read). */
  router.get("/agnb/invoices", async (req, res) => {
    assertBoardOrgAccess(req);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
    const base = sql`
      SELECT id, invoice_number, short_url, customer_name, customer_email, customer_state,
             amount_paise, subtotal_paise, gst_paise, total_paise, status, paid_at, expires_at,
             created_by, created_at
      FROM agnb.topup_links
    `;
    const conditions = [];
    if (status && status !== "all") conditions.push(sql`status = ${status}`);
    if (q) conditions.push(sql`customer_name ILIKE ${`%${q}%`}`);
    const where = conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
    const result = await db.execute(sql`${base}${where} ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, invoices: rows(result) });
  });

  // PHASE 5 (cross-origin, left in standalone AGNB app):
  //  - POST /agnb/attribution/gemini-rematch + /agnb/attribution/rematch (Gemini LLM)
  //  - POST /agnb/invoices/create + POST /agnb/invoices/:id/refresh (Razorpay external API)
  //  - POST/PATCH/DELETE /agnb/win-loss + POST /agnb/win-loss/:id/analyze (writes / LLM)
}
