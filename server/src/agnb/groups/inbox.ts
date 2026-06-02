import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: inbox + content comments.
 * Ported from agnb app/all-gas-no-brakes/api/agnb/inbox + comments.
 * comments/draft-reply calls Gemini (LLM) → Phase 5, left cross-origin.
 */
export function registerInbox(router: Router, db: Db) {
  /** GET /api/agnb/inbox?status= — Rocket inbox threads (non-archived). */
  router.get("/agnb/inbox", async (req, res) => {
    assertBoardOrgAccess(req);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const result =
      status && status !== "all"
        ? await db.execute(sql`
            SELECT thread_id, subject, status, lead_email, lead_name, campaign_name,
                   last_message_at, last_message_preview
            FROM agnb.rocket_inbox
            WHERE archived_at IS NULL AND status = ${status}
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT 200
          `)
        : await db.execute(sql`
            SELECT thread_id, subject, status, lead_email, lead_name, campaign_name,
                   last_message_at, last_message_preview
            FROM agnb.rocket_inbox
            WHERE archived_at IS NULL
            ORDER BY last_message_at DESC NULLS LAST
            LIMIT 200
          `);
    res.json({ ok: true, threads: rows(result) });
  });

  /**
   * POST /api/agnb/inbox/triage-zero
   * Body: { dry_run?: boolean, older_than_days?: number }
   * Bulk-archives inbox threads older than `older_than_days` (default 14)
   * with no positive_signal hit.
   */
  router.post("/agnb/inbox/triage-zero", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const body = (req.body ?? {}) as { dry_run?: boolean; older_than_days?: number };
    const days = Math.max(1, Math.min(180, Number(body.older_than_days ?? 14)));
    const dryRun = body.dry_run === true;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const staleResult = await db.execute(sql`
      SELECT thread_id, lead_email, last_message_at
      FROM agnb.rocket_inbox
      WHERE last_message_at < ${cutoff} AND archived_at IS NULL
      LIMIT 500
    `);
    const candidates = rows<{ thread_id: string; lead_email: string | null; last_message_at: string }>(staleResult);
    if (candidates.length === 0) return res.json({ ok: true, archived: 0, candidates: 0 });

    // Filter out threads with a positive_signal hit
    const emails = candidates.map((c) => c.lead_email).filter((e): e is string => !!e);
    let positiveSet = new Set<string>();
    if (emails.length > 0) {
      const positives = await db.execute(sql`
        SELECT lead_email FROM agnb.positive_signal
        WHERE lead_email IN (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})
      `);
      positiveSet = new Set(
        rows<{ lead_email: string }>(positives).map((p) => p.lead_email.toLowerCase())
      );
    }
    const targets = candidates.filter((c) => !c.lead_email || !positiveSet.has(c.lead_email.toLowerCase()));

    if (dryRun) return res.json({ ok: true, dry_run: true, would_archive: targets.length, candidates: candidates.length });
    if (targets.length === 0) return res.json({ ok: true, archived: 0, candidates: candidates.length });

    const ts = new Date().toISOString();
    const reason = `triage-zero: stale > ${days}d, no positive_signal`;
    const ids = targets.map((t) => t.thread_id);
    await db.execute(sql`
      UPDATE agnb.rocket_inbox
      SET archived_at = ${ts}, archived_by = ${email}, archive_reason = ${reason}
      WHERE thread_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `);
    res.json({ ok: true, archived: targets.length, candidates: candidates.length, older_than_days: days });
  });

  /**
   * POST /api/agnb/inbox/:thread_id/action
   * Body: { action: "archive" | "unarchive" | "mark_positive" }
   */
  router.post("/agnb/inbox/:thread_id/action", async (req, res) => {
    assertBoardOrgAccess(req);
    const email = req.actor.userEmail ?? req.actor.userId ?? "board";
    const threadId = req.params.thread_id;
    const action = (req.body ?? {}).action as string | undefined;

    if (action === "archive") {
      await db.execute(sql`
        UPDATE agnb.rocket_inbox
        SET archived_at = ${new Date().toISOString()}, archived_by = ${email}, archive_reason = 'manual'
        WHERE thread_id = ${threadId}
      `);
      return res.json({ ok: true });
    }

    if (action === "unarchive") {
      await db.execute(sql`
        UPDATE agnb.rocket_inbox
        SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
        WHERE thread_id = ${threadId}
      `);
      return res.json({ ok: true });
    }

    if (action === "mark_positive") {
      const threadResult = await db.execute(sql`
        SELECT lead_email, subject, campaign_name, last_message_preview
        FROM agnb.rocket_inbox
        WHERE thread_id = ${threadId}
        LIMIT 1
      `);
      const thread = rows<{
        lead_email: string | null;
        subject: string | null;
        campaign_name: string | null;
        last_message_preview: string | null;
      }>(threadResult)[0];
      if (!thread?.lead_email) return res.status(400).json({ ok: false, error: "thread has no lead_email" });
      await db.execute(sql`
        INSERT INTO agnb.positive_signal (lead_email, thread_id, subject, snippet, source, detected_at, detected_by)
        VALUES (${thread.lead_email}, ${threadId}, ${thread.subject}, ${thread.last_message_preview},
                'manual', ${new Date().toISOString()}, ${email})
        ON CONFLICT (lead_email, thread_id) DO NOTHING
      `);
      return res.json({ ok: true });
    }

    res.status(400).json({ ok: false, error: "action must be archive|unarchive|mark_positive" });
  });

  /** GET /api/agnb/comments?filter=unanswered|questions|negative — content comments for triage. */
  router.get("/agnb/comments", async (req, res) => {
    assertBoardOrgAccess(req);
    const filter = typeof req.query.filter === "string" ? req.query.filter : null;
    const base = sql`
      SELECT id, platform, author, body, sentiment, is_question, replied, reply_draft, created_at, ingested_at
      FROM agnb.content_comments
    `;
    let result;
    if (filter === "unanswered") {
      result = await db.execute(sql`${base} WHERE replied = false ORDER BY ingested_at DESC LIMIT 200`);
    } else if (filter === "questions") {
      result = await db.execute(sql`${base} WHERE is_question = true AND replied = false ORDER BY ingested_at DESC LIMIT 200`);
    } else if (filter === "negative") {
      result = await db.execute(sql`${base} WHERE sentiment = 'negative' ORDER BY ingested_at DESC LIMIT 200`);
    } else {
      result = await db.execute(sql`${base} ORDER BY ingested_at DESC LIMIT 200`);
    }
    res.json({ ok: true, comments: rows(result) });
  });

  /** PATCH /api/agnb/comments?id=...&replied= — toggle a comment's replied flag (defaults to true). */
  router.patch("/agnb/comments", async (req, res) => {
    assertBoardOrgAccess(req);
    const id = typeof req.query.id === "string" ? req.query.id : null;
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const replied = req.query.replied !== "0";
    await db.execute(sql`
      UPDATE agnb.content_comments SET replied = ${replied} WHERE id = ${id}
    `);
    res.json({ ok: true });
  });

  // PHASE 5: POST /agnb/comments/draft-reply calls Gemini (LLM) to generate a
  // reply draft — external API, not a pure DB op. Left cross-origin in the UI.
}
