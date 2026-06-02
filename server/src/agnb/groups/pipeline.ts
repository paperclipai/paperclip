import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
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
 *  - GET/PATCH /pipeline/tasks, GET /pipeline/details, GET /pipeline/engagements:
 *    all HubSpot API reads.
 *  - pipeline_move_log table is a Supabase-only relation (not migrated), so the
 *    activity feed degrades to comments-only here.
 */
export function registerPipeline(router: Router, db: Db) {
  /** GET /api/agnb/pipeline/comments?deal_id=… — comments for a deal (newest first). */
  router.get("/agnb/pipeline/comments", async (req, res) => {
    assertBoardOrgAccess(req);
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
    assertBoardOrgAccess(req);
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
    assertBoardOrgAccess(req);
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
    assertBoardOrgAccess(req);
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
}
