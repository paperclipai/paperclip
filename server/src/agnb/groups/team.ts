import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: team (members, work items, routing rules).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/team + team/work + team/rules.
 *
 * SKIPPED (Phase 5 — worker territory, left cross-origin in the UI):
 *  - POST /team/ingest    → ingestAll() sweeps source tables to emit work_items.
 *  - POST /team/auto-route → autoRouteBacklog() runs the routing engine (auto-drain).
 *  - PATCH /team/work?action=reassign with NO assignee → assignWorkItem() routing engine.
 *    (Manual reassign with an explicit assignee IS a pure DB op and is ported.)
 */
export function registerTeam(router: Router, db: Db) {
  /**
   * GET /api/agnb/team — list team members + open-load + done-7d per member.
   */
  router.get("/agnb/team", async (req, res) => {
    assertBoardOrgAccess(req);

    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const [membersResult, openResult, done7dResult] = await Promise.all([
      db.execute(sql`
        SELECT * FROM agnb.team_members
        ORDER BY is_ai, name
      `),
      db.execute(sql`
        SELECT assigned_to FROM agnb.work_items
        WHERE status IN ('queued', 'in_progress') AND assigned_to IS NOT NULL
      `),
      db.execute(sql`
        SELECT assigned_to, completed_at FROM agnb.work_items
        WHERE status = 'done' AND completed_at >= ${sevenDaysAgo} AND assigned_to IS NOT NULL
      `),
    ]);

    const openLoad = new Map<string, number>();
    for (const r of rows<{ assigned_to: string }>(openResult)) {
      openLoad.set(r.assigned_to, (openLoad.get(r.assigned_to) ?? 0) + 1);
    }
    const done7dCount = new Map<string, number>();
    for (const r of rows<{ assigned_to: string }>(done7dResult)) {
      done7dCount.set(r.assigned_to, (done7dCount.get(r.assigned_to) ?? 0) + 1);
    }

    const enriched = rows<{ id: string }>(membersResult).map((m) => ({
      ...m,
      open_load: openLoad.get(m.id) ?? 0,
      done_7d: done7dCount.get(m.id) ?? 0,
    }));

    res.json({ ok: true, members: enriched });
  });

  /**
   * POST /api/agnb/team — create teammate.
   */
  router.post("/agnb/team", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as {
      name?: string;
      email?: string;
      role?: string;
      is_ai?: boolean;
      ai_engine?: string;
      skills?: string[];
      capacity_daily?: number;
      weight?: number;
      timezone?: string;
    };

    const name = body.name?.trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const result = await db.execute(sql`
      INSERT INTO agnb.team_members (name, email, role, is_ai, ai_engine, skills, capacity_daily, weight, timezone)
      VALUES (
        ${name},
        ${body.email?.trim() || null},
        ${body.role ?? null},
        ${body.is_ai ?? false},
        ${body.ai_engine ?? null},
        ${body.skills ?? []}::text[],
        ${body.capacity_daily ?? 50},
        ${body.weight ?? 1.0},
        ${body.timezone ?? null}
      )
      RETURNING *
    `);
    res.json({ ok: true, member: rows(result)[0] });
  });

  /**
   * PATCH /api/agnb/team?id=… — edit teammate.
   */
  router.patch("/agnb/team", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const body = (req.body ?? {}) as Partial<{
      name: string;
      email: string;
      role: string;
      skills: string[];
      capacity_daily: number;
      weight: number;
      active: boolean;
      timezone: string;
    }>;

    const sets: ReturnType<typeof sql>[] = [];
    if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
    if (body.email !== undefined) sets.push(sql`email = ${body.email}`);
    if (body.role !== undefined) sets.push(sql`role = ${body.role}`);
    if (body.skills !== undefined) sets.push(sql`skills = ${body.skills}::text[]`);
    if (body.capacity_daily !== undefined) sets.push(sql`capacity_daily = ${body.capacity_daily}`);
    if (body.weight !== undefined) sets.push(sql`weight = ${body.weight}`);
    if (body.active !== undefined) sets.push(sql`active = ${body.active}`);
    if (body.timezone !== undefined) sets.push(sql`timezone = ${body.timezone}`);

    if (sets.length === 0) return res.status(400).json({ ok: false, error: "no fields to update" });

    const result = await db.execute(sql`
      UPDATE agnb.team_members
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}
      RETURNING *
    `);
    res.json({ ok: true, member: rows(result)[0] });
  });

  /**
   * GET /api/agnb/team/work?assignee=…&status=…&kind=…&limit=… — list work items.
   */
  router.get("/agnb/team/work", async (req, res) => {
    assertBoardOrgAccess(req);
    const assignee = typeof req.query.assignee === "string" ? req.query.assignee : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;
    const limit = Math.min(Number(req.query.limit ?? 200), 500);

    const conds: ReturnType<typeof sql>[] = [];
    if (assignee === "unassigned") conds.push(sql`wi.assigned_to IS NULL`);
    else if (assignee) conds.push(sql`wi.assigned_to = ${assignee}`);
    if (status && status !== "all") conds.push(sql`wi.status = ${status}`);
    else if (!status) conds.push(sql`wi.status IN ('queued', 'in_progress')`);
    if (kind) conds.push(sql`wi.kind = ${kind}`);

    const where = conds.length > 0 ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

    const result = await db.execute(sql`
      SELECT wi.*,
             CASE WHEN tm.id IS NULL THEN NULL
                  ELSE json_build_object('name', tm.name, 'is_ai', tm.is_ai, 'email', tm.email)
             END AS team_members
      FROM agnb.work_items wi
      LEFT JOIN agnb.team_members tm ON tm.id = wi.assigned_to
      ${where}
      ORDER BY wi.priority, wi.sla_due_at NULLS LAST
      LIMIT ${limit}
    `);
    res.json({ ok: true, items: rows(result) });
  });

  /**
   * PATCH /api/agnb/team/work?id=…&action=claim|done|block|reopen|reassign
   * Body: { reason?: string; assignee?: string }
   */
  router.patch("/agnb/team/work", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const id = typeof req.query.id === "string" ? req.query.id : null;
    const action = typeof req.query.action === "string" ? req.query.action : null;
    if (!id || !action) return res.status(400).json({ ok: false, error: "id+action required" });

    const now = new Date().toISOString();
    const body = (req.body ?? {}) as { reason?: string; assignee?: string };

    if (action === "claim") {
      // Resolve current operator's member row by email — best effort.
      const meResult = await db.execute(sql`
        SELECT id FROM agnb.team_members WHERE email = ${email} LIMIT 1
      `);
      const me = rows<{ id: string }>(meResult)[0];
      if (me?.id) {
        await db.execute(sql`
          UPDATE agnb.work_items
          SET status = 'in_progress', claimed_at = ${now}, assigned_to = ${me.id}, assigned_at = ${now}
          WHERE id = ${id}
        `);
      } else {
        await db.execute(sql`
          UPDATE agnb.work_items
          SET status = 'in_progress', claimed_at = ${now}
          WHERE id = ${id}
        `);
      }
      return res.json({ ok: true });
    }

    if (action === "done") {
      await db.execute(sql`
        UPDATE agnb.work_items
        SET status = 'done', completed_at = ${now}
        WHERE id = ${id}
      `);
      return res.json({ ok: true });
    }

    if (action === "block") {
      await db.execute(sql`
        UPDATE agnb.work_items
        SET status = 'blocked', blocked_reason = ${body.reason ?? null}
        WHERE id = ${id}
      `);
      return res.json({ ok: true });
    }

    if (action === "reopen") {
      await db.execute(sql`
        UPDATE agnb.work_items
        SET status = 'queued', completed_at = NULL, blocked_reason = NULL
        WHERE id = ${id}
      `);
      return res.json({ ok: true });
    }

    if (action === "reassign") {
      if (body.assignee) {
        // Manual reassign — pure DB op.
        await db.execute(sql`
          UPDATE agnb.work_items
          SET assigned_to = ${body.assignee}, assigned_at = ${now}, status = 'queued', claimed_at = NULL
          WHERE id = ${id}
        `);
        return res.json({ ok: true });
      }
      // PHASE 5: auto-reassign with no explicit assignee invokes the routing
      // engine (assignWorkItem) — worker territory, not a pure DB op. Left
      // cross-origin in the UI.
      return res.status(501).json({ ok: false, error: "auto-reassign not available (Phase 5)" });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  });

  /**
   * GET /api/agnb/team/rules — list routing rules.
   */
  router.get("/agnb/team/rules", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT * FROM agnb.work_routing_rules
      ORDER BY kind, created_at
    `);
    res.json({ ok: true, rules: rows(result) });
  });

  /**
   * POST /api/agnb/team/rules — create rule.
   */
  router.post("/agnb/team/rules", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as {
      kind?: string;
      prefer_skills?: string[];
      strategy?: string;
      fallback_member?: string | null;
      weight?: number;
      notes?: string;
    };

    if (!body.kind) return res.status(400).json({ ok: false, error: "kind required" });

    const result = await db.execute(sql`
      INSERT INTO agnb.work_routing_rules (kind, prefer_skills, strategy, fallback_member, weight, notes)
      VALUES (
        ${body.kind},
        ${body.prefer_skills ?? []}::text[],
        ${body.strategy ?? "skill_then_load"},
        ${body.fallback_member ?? null},
        ${body.weight ?? 1.0},
        ${body.notes ?? null}
      )
      RETURNING *
    `);
    res.json({ ok: true, rule: rows(result)[0] });
  });

  /**
   * PATCH /api/agnb/team/rules?id=… — edit rule.
   */
  router.patch("/agnb/team/rules", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const body = (req.body ?? {}) as Partial<{
      prefer_skills: string[];
      strategy: string;
      fallback_member: string | null;
      weight: number;
      notes: string;
      active: boolean;
    }>;

    const sets: ReturnType<typeof sql>[] = [];
    if (body.prefer_skills !== undefined) sets.push(sql`prefer_skills = ${body.prefer_skills}::text[]`);
    if (body.strategy !== undefined) sets.push(sql`strategy = ${body.strategy}`);
    if (body.fallback_member !== undefined) sets.push(sql`fallback_member = ${body.fallback_member}`);
    if (body.weight !== undefined) sets.push(sql`weight = ${body.weight}`);
    if (body.notes !== undefined) sets.push(sql`notes = ${body.notes}`);
    if (body.active !== undefined) sets.push(sql`active = ${body.active}`);

    if (sets.length === 0) return res.status(400).json({ ok: false, error: "no fields to update" });

    const result = await db.execute(sql`
      UPDATE agnb.work_routing_rules
      SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}
      RETURNING *
    `);
    res.json({ ok: true, rule: rows(result)[0] });
  });

  /**
   * DELETE /api/agnb/team/rules?id=… — soft-delete (set active=false).
   */
  router.delete("/agnb/team/rules", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    await db.execute(sql`
      UPDATE agnb.work_routing_rules SET active = false WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  // PHASE 5: POST /agnb/team/ingest (ingestAll — sweeps source tables to emit
  // work_items) and POST /agnb/team/auto-route (autoRouteBacklog — routing
  // engine auto-drain) are worker tasks, not pure DB ops. Left cross-origin.
}
