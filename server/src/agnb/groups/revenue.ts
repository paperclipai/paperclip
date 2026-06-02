import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: revenue (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{attribution,crm-hygiene,
 * demos,funnel,win-loss,invoices}.
 *
 * Pure-DB GET reads only. The following stay cross-origin (Phase 5 / worker):
 *  - attribution/gemini-rematch + attribution/rematch (Gemini LLM)
 *  - forecast (Monte Carlo simulation + HubSpot stage probabilities, computed)
 *  - invoices/create + invoices/[id]/refresh (Razorpay external API)
 *  - win-loss POST/PATCH/DELETE + win-loss/[id]/analyze (writes/LLM)
 */
export function registerRevenue(router: Router, db: Db) {
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
  //  - GET  /agnb/forecast (Monte Carlo simulation over hubspot_deals × stage probs — computed)
  //  - POST /agnb/invoices/create + POST /agnb/invoices/:id/refresh (Razorpay external API)
  //  - POST/PATCH/DELETE /agnb/win-loss + POST /agnb/win-loss/:id/analyze (writes / LLM)
}
