import type { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: misc (quota, api tokens, workflow recipes, content performance).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{quota,tokens,workflow-recipes,content-performance}.
 *
 * - comments GET/PATCH live in the inbox group (/agnb/comments) — reused, not duplicated here.
 * - comments/draft-reply calls Gemini (LLM) → left cross-origin.
 */

/** Rocket SDR daily quota caps (mirrors agnb lib/rocketsdr/audit ROCKETSDR_QUOTAS). */
const ROCKETSDR_QUOTAS: Record<string, number> = {
  preview_leads: 20,
  create_campaign: 10,
  create_campaign_draft: 10,
  finalize_campaign_draft: 10,
};

/** Public API token = SHA256(plaintext). Plaintext shown once at creation. */
function generateToken(): { plaintext: string; hash: string } {
  const plain = "agnb_" + randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(plain).digest("hex");
  return { plaintext: plain, hash };
}

export function registerMisc(router: Router, db: Db) {
  /** GET /api/agnb/quota — Rocket SDR daily quota usage + 7d average. */
  router.get("/agnb/quota", async (req, res) => {
    assertBoardOrgAccess(req);
    const startToday = new Date();
    startToday.setUTCHours(0, 0, 0, 0);
    const todayIso = startToday.toISOString();
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = await db.execute(sql`
      SELECT method, called_at
      FROM agnb.quota_log
      WHERE called_at >= ${since7}
      LIMIT 20000
    `);
    const data = rows<{ method: string; called_at: string | Date }>(result);

    const today: Record<string, number> = {};
    const week: Record<string, number> = {};
    for (const r of data) {
      week[r.method] = (week[r.method] ?? 0) + 1;
      // called_at comes back as a Date or ISO string; normalize to ISO for compare.
      const calledAtIso = r.called_at instanceof Date ? r.called_at.toISOString() : String(r.called_at);
      if (calledAtIso >= todayIso) today[r.method] = (today[r.method] ?? 0) + 1;
    }
    const usage = Object.entries(ROCKETSDR_QUOTAS)
      .map(([method, cap]) => {
        const used = today[method] ?? 0;
        const avg7d = Math.round((week[method] ?? 0) / 7);
        return { method, used, cap, pct: cap > 0 ? Math.round((used / cap) * 100) : 0, avg7d };
      })
      .sort((a, b) => b.pct - a.pct);
    res.json({ ok: true, usage });
  });

  /**
   * GET /api/agnb/tokens — list public API tokens.
   * Mirrors AGNB select exactly: never returns token_hash (no secret leak).
   */
  router.get("/agnb/tokens", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, scopes, active, created_at, created_by,
             last_used_at, request_count, requests_per_minute, rl_window_count
      FROM agnb.api_tokens
      ORDER BY created_at DESC
    `);
    res.json({ ok: true, tokens: rows(result) });
  });

  /**
   * POST /api/agnb/tokens — create a token, returning plaintext ONCE.
   * Body: { name, scopes?, requests_per_minute? }
   */
  router.post("/agnb/tokens", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as { name?: string; scopes?: string[]; requests_per_minute?: number };
    const name = String(body.name ?? "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name required" });

    const VALID_SCOPES = ["buckets:read", "icps:read", "campaigns:read", "forecast:read", "events:read", "metrics:read", "*"];
    const scopes = (body.scopes ?? []).filter((s) => VALID_SCOPES.includes(s));
    const rpm = Math.max(1, Math.min(6000, Number(body.requests_per_minute ?? 60)));
    const { plaintext, hash } = generateToken();

    const result = await db.execute(sql`
      INSERT INTO agnb.api_tokens (name, scopes, token_hash, created_by, requests_per_minute)
      VALUES (${name}, ${scopes}, ${hash}, ${email}, ${rpm})
      RETURNING id
    `);
    const inserted = rows<{ id: string }>(result)[0];
    if (!inserted) return res.status(500).json({ ok: false, error: "insert failed" });
    res.json({
      ok: true,
      id: inserted.id,
      token: plaintext,
      scopes,
      name,
      requests_per_minute: rpm,
      warning: "Plaintext shown ONCE. Store securely.",
    });
  });

  /** DELETE /api/agnb/tokens?id= — revoke (delete) a token. */
  router.delete("/agnb/tokens", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.api_tokens WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /** GET /api/agnb/workflow-recipes — list workflow recipes. */
  router.get("/agnb/workflow-recipes", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, trigger_event, trigger_filter, actions, active,
             created_at, created_by, last_fired_at, fire_count
      FROM agnb.workflow_recipes
      ORDER BY created_at DESC
    `);
    res.json({ ok: true, recipes: rows(result) });
  });

  /**
   * POST /api/agnb/workflow-recipes — create a recipe.
   * Body: { name?, trigger_event?, trigger_filter?, actions?, active? }
   */
  router.post("/agnb/workflow-recipes", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim() || "untitled";
    const triggerEvent = String(body.trigger_event ?? "");
    const triggerFilter = body.trigger_filter ?? {};
    const actions = body.actions ?? [];
    const active = body.active !== false;

    const result = await db.execute(sql`
      INSERT INTO agnb.workflow_recipes (name, trigger_event, trigger_filter, actions, active, created_by)
      VALUES (${name}, ${triggerEvent}, ${JSON.stringify(triggerFilter)}::jsonb,
              ${JSON.stringify(actions)}::jsonb, ${active}, ${email})
      RETURNING id
    `);
    const inserted = rows<{ id: string }>(result)[0];
    res.json({ ok: true, id: inserted?.id });
  });

  /** PATCH /api/agnb/workflow-recipes — toggle active. Body: { id, active } */
  router.patch("/agnb/workflow-recipes", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { id?: string; active?: boolean };
    if (!body.id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`
      UPDATE agnb.workflow_recipes SET active = ${body.active} WHERE id = ${body.id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/workflow-recipes?id= — delete a recipe. */
  router.delete("/agnb/workflow-recipes", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.workflow_recipes WHERE id = ${id}`);
    res.json({ ok: true });
  });

  /**
   * GET /api/agnb/content-performance?days=N — cross-platform content metrics.
   * Mirrors AGNB select exactly; top 100 by views within the window.
   */
  router.get("/agnb/content-performance", async (req, res) => {
    assertBoardOrgAccess(req);
    const raw = typeof req.query.days === "string" ? parseInt(req.query.days, 10) : 30;
    const days = Math.max(1, Math.min(365, Number.isFinite(raw) ? raw : 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const result = await db.execute(sql`
      SELECT id, platform, url, impressions, views, reactions, comments, shares,
             ctr_pct, watch_time_sec, sampled_at
      FROM agnb.content_performance
      WHERE sampled_at >= ${since}
      ORDER BY views DESC
      LIMIT 100
    `);
    res.json({ ok: true, rows: rows(result), days });
  });

  // POST /agnb/comments/draft-reply calls Gemini (LLM) — left cross-origin.
}
