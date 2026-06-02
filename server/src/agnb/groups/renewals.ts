import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: renewals + ops content (newsletter, changelog, press releases).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/{renewals,newsletter,
 * changelog-queue,press-releases,press-release}.
 *
 * Drafting endpoints (changelog-drafter, newsletter-drafter crons, and the
 * press-release Gemini drafter) call an LLM / are cron jobs → Phase 5, left
 * cross-origin in the UI.
 */
export function registerRenewals(router: Router, db: Db) {
  const VALID_KINDS = new Set(["vendor", "compliance", "tax", "license", "insurance", "misc"]);
  const VALID_STATUS = new Set(["upcoming", "reminded", "renewed", "cancelled"]);

  /** GET /api/agnb/renewals — internal.renewals (vendor + compliance + tax + license). */
  router.get("/agnb/renewals", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, kind, name, vendor, amount_paise, currency, renewal_date, status,
             notes, owner_email, last_reminded_at, created_at
      FROM agnb.renewals
      ORDER BY renewal_date ASC
      LIMIT 200
    `);
    res.json({ ok: true, renewals: rows(result) });
  });

  /** POST /api/agnb/renewals — create a renewal. */
  router.post("/agnb/renewals", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, any>;
    if (!body.name || !body.renewal_date || !VALID_KINDS.has(body.kind)) {
      return res.status(400).json({ ok: false, error: "name, renewal_date, kind required" });
    }
    const reminderDays: number[] = Array.isArray(body.reminder_days_before)
      ? body.reminder_days_before
      : [30, 7, 1];
    const result = await db.execute(sql`
      INSERT INTO agnb.renewals (kind, name, vendor, amount_paise, currency, renewal_date,
                                 reminder_days_before, notes, owner_email)
      VALUES (${body.kind}, ${String(body.name).trim()},
              ${body.vendor != null ? String(body.vendor).trim() : null},
              ${body.amount_paise ?? null}, ${body.currency ?? "INR"}, ${body.renewal_date},
              ${`{${reminderDays.map((n) => Number(n)).join(",")}}`}::integer[], ${body.notes != null ? String(body.notes).trim() : null},
              ${body.owner_email ?? email})
      RETURNING *
    `);
    res.json({ ok: true, row: rows(result)[0] ?? null });
  });

  /** PATCH /api/agnb/renewals?id= — update fields on a renewal. */
  router.patch("/agnb/renewals", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;

    const sets = [sql`updated_at = ${new Date().toISOString()}`];
    for (const k of ["name", "vendor", "amount_paise", "renewal_date", "notes", "owner_email"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if ("reminder_days_before" in body) {
      const arr = Array.isArray(body.reminder_days_before) ? body.reminder_days_before : [];
      sets.push(sql`reminder_days_before = ${`{${arr.map((n: unknown) => Number(n)).join(",")}}`}::integer[]`);
    }
    if (body.status && VALID_STATUS.has(body.status)) sets.push(sql`status = ${body.status}`);

    await db.execute(sql`
      UPDATE agnb.renewals SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/renewals?id= */
  router.delete("/agnb/renewals", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.renewals WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // --- newsletter_issues ---

  /** GET /api/agnb/newsletter — list newsletter_issues. */
  router.get("/agnb/newsletter", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, issue_number, period_start, period_end, subject, intro, blog_ids,
             body_html, status, sent_at, created_at
      FROM agnb.newsletter_issues
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, issues: rows(result) });
  });

  /** PATCH /api/agnb/newsletter?id= — publish/mark or edit. */
  router.patch("/agnb/newsletter", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["issue_number", "period_start", "period_end", "subject", "intro", "body_html", "status", "sent_at"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if ("blog_ids" in body) {
      const arr = Array.isArray(body.blog_ids) ? body.blog_ids : [];
      sets.push(sql`blog_ids = ${`{${arr.map((v: unknown) => String(v)).join(",")}}`}::uuid[]`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`
      UPDATE agnb.newsletter_issues SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/newsletter?id= */
  router.delete("/agnb/newsletter", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.newsletter_issues WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // --- changelog_drafts ---

  /** GET /api/agnb/changelog-queue — list changelog_drafts. */
  router.get("/agnb/changelog-queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, version, period_start, period_end, commit_count, markdown, status,
             published_at, created_at
      FROM agnb.changelog_drafts
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, changelog: rows(result) });
  });

  /** PATCH /api/agnb/changelog-queue?id= — publish/mark or edit. */
  router.patch("/agnb/changelog-queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["version", "period_start", "period_end", "commit_count", "markdown", "status", "published_at"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`
      UPDATE agnb.changelog_drafts SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/changelog-queue?id= */
  router.delete("/agnb/changelog-queue", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.changelog_drafts WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // --- press_releases ---

  /** GET /api/agnb/press-releases — list press_releases. */
  router.get("/agnb/press-releases", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, trigger_event, headline, subhead, body, quote, spokesperson_name,
             spokesperson_title, status, created_at
      FROM agnb.press_releases
      ORDER BY created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, releases: rows(result) });
  });

  /** PATCH /api/agnb/press-releases?id= — publish/mark or edit. */
  router.patch("/agnb/press-releases", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const body = (req.body ?? {}) as Record<string, any>;
    const sets = [];
    for (const k of ["trigger_event", "headline", "subhead", "body", "quote", "spokesperson_name", "spokesperson_title", "status"]) {
      if (k in body) sets.push(sql`${sql.identifier(k)} = ${body[k]}`);
    }
    if (sets.length === 0) return res.json({ ok: true });
    await db.execute(sql`
      UPDATE agnb.press_releases SET ${sql.join(sets, sql`, `)} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  /** DELETE /api/agnb/press-releases?id= */
  router.delete("/agnb/press-releases", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    await db.execute(sql`DELETE FROM agnb.press_releases WHERE id = ${id}`);
    res.json({ ok: true });
  });

  // PHASE 5: POST /agnb/press-release drafts a release via Gemini (LLM) — external
  // API, not a pure DB op. Left cross-origin in the UI.
  //
  // PHASE 5: crons renewal-reminders, newsletter-drafter, changelog-drafter send
  // email (Resend) / draft via LLM on a schedule → worker. Left cross-origin.
}
