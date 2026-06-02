import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: linkedin queue / hooks / series (reads + CRUD).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{linkedin-queue,linkedin-hooks,
 * linkedin-series} and the write routes under linkedin/{queue,hooks,series}.
 *
 * NOTE: /agnb/linkedin (profiles read) is owned by another group — not registered here.
 * PHASE 5: /linkedin/extract drafts posts via Gemini (LLM) and the linkedin-poster
 * cron posts via the sidecar (LINKEDIN_SIDECAR_URL) — external, left cross-origin.
 */
const VALID_ANGLES = ["contrarian", "personal", "stat", "question", "listicle"];

export function registerLinkedin(router: Router, db: Db) {
  /** GET /api/agnb/linkedin-queue — full post queue (Queue / Scheduled / Performance). */
  router.get("/agnb/linkedin-queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, source_type, content, scheduled_at, posted_at, linkedin_post_url, status,
             x_variant, series_id, episode_num, impressions, reactions, comments_count,
             worked_why, error_message, created_by, created_at, updated_at
      FROM agnb.linkedin_post_queue
      ORDER BY scheduled_at ASC NULLS FIRST
      LIMIT 500
    `);
    res.json({ ok: true, rows: rows(result) });
  });

  /** GET /api/agnb/linkedin-hooks — LinkedIn hook bank. */
  router.get("/agnb/linkedin-hooks", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, hook, angle, uses, notes, created_at
      FROM agnb.linkedin_hooks
      ORDER BY uses DESC, created_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, hooks: rows(result) });
  });

  /** GET /api/agnb/linkedin-series — series + episode progress derived from the queue. */
  router.get("/agnb/linkedin-series", async (req, res) => {
    assertBoardOrgAccess(req);
    const [seriesResult, queueResult] = await Promise.all([
      db.execute(sql`
        SELECT id, title, description, episodes, status, created_at
        FROM agnb.linkedin_series
        ORDER BY created_at DESC
        LIMIT 50
      `),
      db.execute(sql`
        SELECT series_id, status
        FROM agnb.linkedin_post_queue
        WHERE series_id IS NOT NULL
      `),
    ]);
    const counts = new Map<string, { total: number; posted: number }>();
    for (const r of rows<{ series_id: string; status: string }>(queueResult)) {
      const c = counts.get(r.series_id) ?? { total: 0, posted: 0 };
      c.total++;
      if (r.status === "posted" || r.status === "published") c.posted++;
      counts.set(r.series_id, c);
    }
    const out = rows<{ id: string }>(seriesResult).map((s) => ({
      ...s,
      total: counts.get(s.id)?.total ?? 0,
      posted: counts.get(s.id)?.posted ?? 0,
    }));
    res.json({ ok: true, series: out });
  });

  // --- queue CRUD (UI: /linkedin/queue) ---

  /**
   * POST /api/agnb/linkedin/queue
   * Body: { content, scheduled_at?, source_type?, source_id? } — add manual / repurposed post.
   */
  router.post("/agnb/linkedin/queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as {
      content?: string;
      scheduled_at?: string | null;
      source_type?: string;
      source_id?: string | null;
    };
    if (!body.content?.trim()) return res.status(400).json({ ok: false, error: "content required" });

    const result = await db.execute(sql`
      INSERT INTO agnb.linkedin_post_queue (source_type, source_id, content, scheduled_at, status, created_by)
      VALUES (
        ${body.source_type ?? "manual"},
        ${body.source_id ?? null},
        ${body.content.trim()},
        ${body.scheduled_at ?? null},
        ${body.scheduled_at ? "scheduled" : "queued"},
        ${email}
      )
      RETURNING *
    `);
    res.json({ ok: true, row: rows(result)[0] });
  });

  /** PATCH /api/agnb/linkedin/queue?id=... — update content/scheduled_at/status. */
  router.patch("/agnb/linkedin/queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as {
      content?: string;
      scheduled_at?: string | null;
      status?: string;
      linkedin_post_url?: string;
    };

    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    if (typeof body.content === "string") sets.push(sql`content = ${body.content}`);
    if (typeof body.scheduled_at !== "undefined") sets.push(sql`scheduled_at = ${body.scheduled_at}`);
    if (typeof body.status === "string") sets.push(sql`status = ${body.status}`);
    if (body.status === "posted") {
      sets.push(sql`posted_at = ${new Date().toISOString()}`);
      if (typeof body.linkedin_post_url === "string") sets.push(sql`linkedin_post_url = ${body.linkedin_post_url}`);
    }
    await db.execute(sql`
      UPDATE agnb.linkedin_post_queue SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/linkedin/queue?id=... — remove a queued post. */
  router.delete("/agnb/linkedin/queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.linkedin_post_queue WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // --- hooks CRUD (UI: /linkedin/hooks) ---

  /** POST /api/agnb/linkedin/hooks — Body: { hook, angle, notes? }. */
  router.post("/agnb/linkedin/hooks", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { hook?: string; angle?: string; notes?: string };
    if (!body.hook?.trim() || !body.angle) return res.status(400).json({ ok: false, error: "hook + angle required" });
    if (!VALID_ANGLES.includes(body.angle)) return res.status(400).json({ ok: false, error: "bad angle" });
    const result = await db.execute(sql`
      INSERT INTO agnb.linkedin_hooks (hook, angle, notes)
      VALUES (${body.hook.trim()}, ${body.angle}, ${body.notes ?? null})
      RETURNING *
    `);
    res.json({ ok: true, hook: rows(result)[0] });
  });

  /** DELETE /api/agnb/linkedin/hooks?id=... */
  router.delete("/agnb/linkedin/hooks", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.linkedin_hooks WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // --- series CRUD (UI: /linkedin/series) ---

  /** POST /api/agnb/linkedin/series — Body: { title, description? }. */
  router.post("/agnb/linkedin/series", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { title?: string; description?: string };
    if (!body.title?.trim()) return res.status(400).json({ ok: false, error: "title required" });
    const result = await db.execute(sql`
      INSERT INTO agnb.linkedin_series (title, description)
      VALUES (${body.title.trim()}, ${body.description?.trim() ?? null})
      RETURNING *
    `);
    res.json({ ok: true, series: rows(result)[0] });
  });

  /** PATCH /api/agnb/linkedin/series?id=... — Body: { title?, description?, status? }. */
  router.patch("/agnb/linkedin/series", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as { title?: string; description?: string; status?: string };
    const sets = [];
    if (typeof body.title === "string") sets.push(sql`title = ${body.title}`);
    if (typeof body.description === "string") sets.push(sql`description = ${body.description}`);
    if (typeof body.status === "string") sets.push(sql`status = ${body.status}`);
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`
      UPDATE agnb.linkedin_series SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/linkedin/series?id=... */
  router.delete("/agnb/linkedin/series", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.linkedin_series WHERE id = ${id}`);
    res.json({ ok: true });
  });
}
