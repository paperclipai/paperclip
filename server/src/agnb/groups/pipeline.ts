import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: pipeline comments + activity (pure-DB reads/CRUD).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/pipeline.
 *
 * PHASE 5 (left cross-origin in the UI — external HubSpot CRM / not migrated):
 *  - GET  /pipeline (loadPipelineBoard): deals/pipelines/owners/contacts/
 *    companies + funnel are all live HubSpot API reads. The hubspot_deals base
 *    table exists in agnb but the board's stage labels, funnel, owners, and
 *    contacts come from the live CRM API, so the board stays cross-origin.
 *  - POST /pipeline/move:    HubSpot updateDealStage.
 *  - POST /pipeline/create:  HubSpot createDeal.
 *  - PATCH /pipeline/tasks, GET /pipeline/engagements: HubSpot API writes/reads.
 *  - pipeline_move_log table is a Supabase-only relation (not migrated), so the
 *    activity feed degrades to comments-only here.
 */
export function registerPipeline(router: Router, db: Db) {
  /** GET /api/agnb/pipeline/comments?deal_id=… — comments for a deal (newest first). */
  router.get("/agnb/pipeline/comments", async (req, res) => {
    assertAgnbAccess(req);
    const dealId = typeof req.query.deal_id === "string" ? req.query.deal_id : null;
    if (!dealId) return res.status(400).json({ ok: false, error: "deal_id required" });
    const result = await db.execute(sql`
      SELECT id, deal_id, author, body, created_at
      FROM agnb.pipeline_comments
      WHERE deal_id = ${dealId}
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, comments: rows(result) });
  });

  /** POST /api/agnb/pipeline/comments — body: { deal_id, body }. */
  router.post("/agnb/pipeline/comments", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as { deal_id?: string; body?: string };
    if (!body.deal_id || !body.body?.trim()) {
      return res.status(400).json({ ok: false, error: "deal_id + body required" });
    }
    const result = await db.execute(sql`
      INSERT INTO agnb.pipeline_comments (deal_id, author, body)
      VALUES (${body.deal_id}, ${email}, ${body.body.trim()})
      RETURNING id, deal_id, author, body, created_at
    `);
    // PHASE 5: AGNB also mirrors the comment into HubSpot as a deal note
    // (createNoteForDeal) — external CRM side-effect, dropped on this DB-only port.
    res.json({ ok: true, comment: rows(result)[0] });
  });

  /** DELETE /api/agnb/pipeline/comments?id=… — delete (author only). */
  router.delete("/agnb/pipeline/comments", async (req, res) => {
    assertAgnbAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`
      DELETE FROM agnb.pipeline_comments WHERE id = ${id} AND author = ${email}
    `);
    res.json({ ok: true });
  });

  /**
   * GET /api/agnb/pipeline/activity?deal_id=… — chronological feed for a deal.
   * PHASE 5: pipeline_move_log is not migrated, so "move" entries are omitted;
   * the feed is comments-only until that table lands in agnb.
   */
  router.get("/agnb/pipeline/activity", async (req, res) => {
    assertAgnbAccess(req);
    const dealId = typeof req.query.deal_id === "string" ? req.query.deal_id : null;
    if (!dealId) return res.status(400).json({ ok: false, error: "deal_id required" });

    const out: Array<{ kind: "move" | "comment"; id: string; at: string; by: string; body: string }> = [];

    const commentsResult = await db.execute(sql`
      SELECT id, author, body, created_at
      FROM agnb.pipeline_comments
      WHERE deal_id = ${dealId}
      ORDER BY created_at DESC
      LIMIT 100
    `);
    for (const r of rows<{ id: string; author: string; body: string; created_at: string }>(commentsResult)) {
      out.push({ kind: "comment", id: r.id, at: r.created_at, by: r.author, body: r.body });
    }

    out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json({ ok: true, activity: out });
  });

  /**
   * GET /api/agnb/pipeline/tasks?deal_id=… — checklist tasks for a deal.
   * Ported same-origin to kill the cross-origin call after AGNB decommission.
   * PHASE5: AGNB read these live from HubSpot (listTasksForDeal) — there is NO
   * agnb mirror table for HubSpot tasks, so the DB has nothing to return. We
   * preserve the exact response shape ({ ok, tasks }) with an empty list until a
   * task mirror lands. (deal_id still validated to match the old contract.)
   */
  router.get("/agnb/pipeline/tasks", async (req, res) => {
    assertAgnbAccess(req);
    const dealId = typeof req.query.deal_id === "string" ? req.query.deal_id : null;
    if (!dealId) return res.status(400).json({ ok: false, error: "deal_id required" });
    res.json({ ok: true, tasks: [] });
  });

  /**
   * GET /api/agnb/pipeline/details?deal_id=… — line items + quotes + tickets.
   * Ported same-origin to kill the cross-origin call after AGNB decommission.
   * PHASE5: AGNB read these live from HubSpot (listLineItemsForDeal /
   * listQuotesForDeal / listTicketsForDeal) — there are NO agnb mirror tables for
   * line items, quotes, or tickets, so the DB has nothing to return. We preserve
   * the exact response shape ({ ok, lineItems, quotes, tickets }) with empty
   * lists until those mirrors land.
   */
  router.get("/agnb/pipeline/details", async (req, res) => {
    assertAgnbAccess(req);
    const dealId = typeof req.query.deal_id === "string" ? req.query.deal_id : null;
    if (!dealId) return res.status(400).json({ ok: false, error: "deal_id required" });
    res.json({ ok: true, lineItems: [], quotes: [], tickets: [] });
  });

  /**
   * GET /api/agnb/pipeline/board — read-only deal board from the agnb.hubspot_deals
   * mirror (the live-HubSpot board was decommissioned). Groups deals by dealstage
   * into columns; the Sales-Ops Analyst agent keeps the mirror current via
   * POST /pipeline/deals.
   */
  router.get("/agnb/pipeline/board", async (req, res) => {
    assertAgnbAccess(req);
    const result = await db.execute(sql`
      SELECT id, dealname, dealstage, amount_usd, close_date
      FROM agnb.hubspot_deals
      ORDER BY amount_usd DESC NULLS LAST
    `);
    type Deal = { id: string; dealname: string | null; dealstage: string | null; amount_usd: number | string | null; close_date: string | null };
    const deals = rows<Deal>(result);
    const byStage = new Map<string, { id: string; label: string; cards: Array<{ id: string; name: string; amount: number; closeDate: string | null }>; total: number }>();
    for (const d of deals) {
      const stage = (d.dealstage ?? "unknown").trim() || "unknown";
      if (!byStage.has(stage)) byStage.set(stage, { id: stage, label: stage, cards: [], total: 0 });
      const col = byStage.get(stage)!;
      const amount = Number(d.amount_usd ?? 0) || 0;
      col.cards.push({ id: d.id, name: d.dealname ?? "(unnamed deal)", amount, closeDate: d.close_date });
      col.total += amount;
    }
    res.json({ ok: true, columns: [...byStage.values()] });
  });

  /**
   * POST /api/agnb/pipeline/deals — Sales-Ops Analyst agent ingests/refreshes
   * deals into the mirror. Body: { deals: Array<{ id, dealname, dealstage,
   * amount_usd?, close_date? }> }. Upsert by id (the HubSpot deal id; no live
   * HubSpot write).
   */
  router.post("/agnb/pipeline/deals", async (req, res) => {
    assertAgnbAccess(req);
    const body = (req.body ?? {}) as { deals?: Array<Record<string, unknown>> };
    const list = Array.isArray(body.deals) ? body.deals : [];
    if (list.length === 0) {
      res.status(400).json({ ok: false, error: "deals[] required" });
      return;
    }
    let upserted = 0;
    for (const d of list) {
      const id = String(d?.id ?? "").trim();
      const dealname = String(d?.dealname ?? "").trim();
      const dealstage = String(d?.dealstage ?? "").trim();
      if (!id || !dealname || !dealstage) continue;
      const amountUsd = typeof d?.amount_usd === "number" ? d.amount_usd : null;
      const closeDate = typeof d?.close_date === "string" ? d.close_date : null;
      const upd = await db.execute(sql`
        UPDATE agnb.hubspot_deals
        SET dealname = ${dealname}, dealstage = ${dealstage},
            amount_usd = COALESCE(${amountUsd}, amount_usd),
            close_date = COALESCE(${closeDate}::timestamptz, close_date)
        WHERE id = ${id}
        RETURNING id
      `);
      if (rows(upd).length === 0) {
        await db.execute(sql`
          INSERT INTO agnb.hubspot_deals (id, dealname, dealstage, amount_usd, close_date)
          VALUES (${id}, ${dealname}, ${dealstage}, ${amountUsd}, ${closeDate}::timestamptz)
        `);
      }
      upserted++;
    }
    res.json({ ok: true, upserted });
  });
}
