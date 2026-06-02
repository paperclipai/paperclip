import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: ops (read-only DB endpoints).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{audit,entity-audit,events,
 * notifications,pending-actions}.
 *
 * PHASE 5 (left cross-origin, external/sync/cron — NOT ported here):
 *   - /health (Paperclip has its own health check)
 *   - /sync, /inbound/*\/sync, /rocket/sync-all, /events/drain
 *   - /alerts/check, /maintenance/*, /attribution/rematch
 *   - write/decision PATCH/POST handlers that call external SDKs (e.g.
 *     pending-actions PATCH → skipLead, notifications PATCH → per-user marks).
 */
export function registerOps(router: Router, db: Db) {
  /** GET /api/agnb/audit — recent api_audit rows. */
  router.get("/agnb/audit", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, method, ok, error, duration_ms, caller, called_at
      FROM agnb.api_audit
      ORDER BY called_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, audit: rows(result) });
  });

  /** GET /api/agnb/entity-audit — recent entity_audit rows. */
  router.get("/agnb/entity-audit", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, entity_type, entity_id, action, diff, actor_email, created_at
      FROM agnb.entity_audit
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, audit: rows(result) });
  });

  /** GET /api/agnb/events — recent events (NOT /events/drain). */
  router.get("/agnb/events", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, event_type, payload, bucket_id, source, created_at, processed_at, processor_error
      FROM agnb.events
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, events: rows(result) });
  });

  /**
   * GET /api/agnb/notifications — notifications + this operator's read ids.
   * Read-state is per-user (agnb.notification_reads), not shared.
   */
  router.get("/agnb/notifications", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const [notifications, reads] = await Promise.all([
      db.execute(sql`
        SELECT id, kind, severity, title, body, link, created_at, pushed_channels
        FROM agnb.notifications
        ORDER BY created_at DESC
        LIMIT 200
      `),
      db.execute(sql`
        SELECT notification_id
        FROM agnb.notification_reads
        WHERE email = ${email}
      `),
    ]);
    const readIds = rows<{ notification_id: string }>(reads).map((r) => r.notification_id);
    res.json({ ok: true, notifications: rows(notifications), readIds });
  });

  /** GET /api/agnb/pending-actions — pending (undecided) actions. */
  router.get("/agnb/pending-actions", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, action_type, payload, bucket_id, proposed_by, proposed_at,
             decision, reviewed_by, reviewed_at, executed_at, execution_result
      FROM agnb.pending_actions
      WHERE decision IS NULL
      ORDER BY proposed_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, pending: rows(result) });
  });

  // PHASE 5: PATCH /agnb/notifications (mark read, per-user) and
  // PATCH /agnb/pending-actions (approve/reject → executes skipLead via the
  // Rocket SDK). Both are write/external ops — left cross-origin in the UI.
}
