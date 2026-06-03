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
 *   - /inbound/*\/sync, /rocket/sync-all, /events/drain
 *   - /alerts/check, /maintenance/*, /attribution/rematch
 *   - write/decision PATCH/POST handlers that call external SDKs (e.g.
 *     pending-actions PATCH → skipLead, notifications PATCH → per-user marks).
 */
type HealthCheck = { name: string; status: "ok" | "degraded" | "down" | "unknown"; detail: string };

export function registerOps(router: Router, db: Db) {
  /**
   * GET /api/agnb/health — cheap DB-side health checks.
   * Ported from agnb app/all-gas-no-brakes/api/agnb/health. All probes here read
   * the agnb mirror tables; no live external probes (those stayed best-effort in
   * AGNB and are deferred). Response shape: { ok, checks: HealthCheck[] }.
   */
  router.get("/agnb/health", async (req, res) => {
    assertBoardOrgAccess(req);
    const checks: HealthCheck[] = [];

    try {
      const start = Date.now();
      const r = await db.execute(sql`SELECT COUNT(*)::int AS count FROM agnb.experiment_buckets`);
      const count = rows<{ count: number }>(r)[0]?.count ?? 0;
      checks.push({ name: "Supabase (internal)", status: "ok", detail: `${count} buckets · ${Date.now() - start}ms` });
    } catch (e) {
      checks.push({ name: "Supabase (internal)", status: "down", detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const r = await db.execute(sql`
        SELECT finished_at, ok, campaigns
        FROM agnb.rocket_sync_log
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1
      `);
      const data = rows<{ finished_at: string | null; ok: boolean | null; campaigns: number | null }>(r)[0];
      if (!data) checks.push({ name: "Rocket sync", status: "unknown", detail: "never run" });
      else {
        const age = data.finished_at ? Math.round((Date.now() - new Date(data.finished_at).getTime()) / 60000) : null;
        checks.push({
          name: "Rocket sync",
          status: !data.ok ? "down" : age != null && age > 120 ? "degraded" : "ok",
          detail: `last ok ${age != null ? `${age}m ago` : "—"} · ${data.campaigns ?? 0} campaigns`,
        });
      }
    } catch (e) {
      checks.push({ name: "Rocket sync", status: "down", detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const tenMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const r = await db.execute(sql`
        SELECT COUNT(*)::int AS count
        FROM agnb.events
        WHERE processed_at IS NULL AND created_at < ${tenMin}
      `);
      const count = rows<{ count: number }>(r)[0]?.count ?? 0;
      checks.push({
        name: "Events processor",
        status: count > 0 ? "degraded" : "ok",
        detail: count > 0 ? `${count} stuck >10min` : "all processed",
      });
    } catch (e) {
      checks.push({ name: "Events processor", status: "unknown", detail: e instanceof Error ? e.message : String(e) });
    }

    try {
      const r = await db.execute(sql`
        SELECT beat_at, worker_id
        FROM agnb.worker_heartbeats
        ORDER BY beat_at DESC
        LIMIT 1
      `);
      const data = rows<{ beat_at: string; worker_id: string }>(r)[0];
      if (!data) checks.push({ name: "AGNB worker", status: "down", detail: "no heartbeat" });
      else {
        const ageSec = Math.round((Date.now() - new Date(data.beat_at).getTime()) / 1000);
        checks.push({
          name: "AGNB worker",
          status: ageSec < 90 ? "ok" : ageSec < 300 ? "degraded" : "down",
          detail: `${data.worker_id} · ${ageSec}s ago`,
        });
      }
    } catch (e) {
      checks.push({ name: "AGNB worker", status: "unknown", detail: e instanceof Error ? e.message : String(e) });
    }

    res.json({ ok: true, checks });
  });

  /**
   * GET /api/agnb/sync — sync console stats + worker job status.
   * Ported from agnb app/all-gas-no-brakes/api/agnb/sync. Triggers (POST job
   * runs) stay cross-origin (Phase 5). Shape: { ok, counts, worker }.
   */
  router.get("/agnb/sync", async (req, res) => {
    assertBoardOrgAccess(req);
    const [logR, unprocessedR, unmatchedR, inboxR, hbR] = await Promise.all([
      db.execute(sql`
        SELECT finished_at, ok, campaigns
        FROM agnb.rocket_sync_log
        ORDER BY finished_at DESC NULLS LAST
        LIMIT 1
      `),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM agnb.events WHERE processed_at IS NULL`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM agnb.attribution_events WHERE match_method = 'unmatched'`),
      db.execute(sql`SELECT COUNT(*)::int AS count FROM agnb.rocket_inbox`),
      db.execute(sql`
        SELECT worker_id, beat_at, jobs
        FROM agnb.worker_heartbeats
        ORDER BY beat_at DESC
        LIMIT 1
      `),
    ]);
    const log = rows<{ finished_at: string | null; ok: boolean | null }>(logR)[0];
    const lastSyncMin = log?.finished_at ? Math.round((Date.now() - new Date(log.finished_at).getTime()) / 60000) : null;
    const hb = rows<{ worker_id: string; beat_at: string; jobs: unknown }>(hbR)[0];
    res.json({
      ok: true,
      counts: {
        lastSyncMin,
        lastSyncOk: log?.ok ?? null,
        inbox: rows<{ count: number }>(inboxR)[0]?.count ?? 0,
        unprocessed: rows<{ count: number }>(unprocessedR)[0]?.count ?? 0,
        unmatched: rows<{ count: number }>(unmatchedR)[0]?.count ?? 0,
      },
      worker: hb ? { worker_id: hb.worker_id, beat_at: hb.beat_at, jobs: hb.jobs ?? [] } : null,
    });
  });

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
