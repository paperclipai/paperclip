import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertBoardOrgAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";
import { extractWhatsAppWork } from "../lib/whatsapp-extract.js";

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

  /** GET /api/agnb/replies — reply mining log (intent-tagged). Pure DB. */
  router.get("/agnb/replies", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, campaign_name, from_email, from_name, subject, body, intent,
             intent_confidence, objection_cluster, next_action, received_at, logged_by
      FROM agnb.reply_log
      ORDER BY received_at DESC
      LIMIT 200
    `);
    res.json({ ok: true, replies: rows(result) });
  });

  /** GET /api/agnb/reply-drafts?status= — composed reply drafts. Pure DB. */
  router.get("/agnb/reply-drafts", async (req, res) => {
    assertBoardOrgAccess(req);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const result =
      status && status !== "all"
        ? await db.execute(sql`
            SELECT * FROM agnb.reply_drafts
            WHERE status = ${status}
            ORDER BY created_at DESC
            LIMIT 200
          `)
        : await db.execute(sql`
            SELECT * FROM agnb.reply_drafts
            ORDER BY created_at DESC
            LIMIT 200
          `);
    res.json({ ok: true, drafts: rows(result) });
  });

  /** PATCH /api/agnb/reply-drafts — Body: { id, status, sent_at? }. Pure DB. */
  router.patch("/agnb/reply-drafts", async (req, res) => {
    assertBoardOrgAccess(req);
    const body = (req.body ?? {}) as { id?: string; status?: string; sent_at?: string };
    if (!body.id || !body.status) return res.status(400).json({ ok: false, error: "id + status required" });
    if (!["draft", "queued", "sent", "cancelled"].includes(body.status)) {
      return res.status(400).json({ ok: false, error: "bad status" });
    }
    if (body.status === "sent") {
      const sentAt = body.sent_at ?? new Date().toISOString();
      await db.execute(sql`
        UPDATE agnb.reply_drafts SET status = ${body.status}, sent_at = ${sentAt} WHERE id = ${body.id}
      `);
    } else {
      await db.execute(sql`
        UPDATE agnb.reply_drafts SET status = ${body.status} WHERE id = ${body.id}
      `);
    }
    res.json({ ok: true });
  });

  /** GET /api/agnb/approval — campaign-draft approval queue. Pure DB. */
  router.get("/agnb/approval", async (req, res) => {
    assertBoardOrgAccess(req);
    const result = await db.execute(sql`
      SELECT id, name, product_id, persona_id, status, notes, rocket_campaign_id,
             created_at, created_by, approved_at
      FROM agnb.campaign_drafts
      ORDER BY created_at DESC
      LIMIT 500
    `);
    res.json({ ok: true, drafts: rows(result) });
  });

  // POST /internal/approval/:id (approve/reject/finalize) calls Rocket SDR on
  // finalize (lib/rocketsdr/client) — external API. Left cross-origin in the UI.

  /**
   * POST /api/agnb/whatsapp/ingest — Baileys sidecar webhook.
   *   Header: Authorization: Bearer <WHATSAPP_SIDECAR_TOKEN>
   *   Body:   { wa_message_id, group_jid, group_name, sender_phone,
   *             sender_name, body }
   *
   * Ported from agnb api/internal/whatsapp-intake. This is SIDECAR-called, not
   * a board-session request: auth is the shared bearer token (checked here);
   * we do NOT call assertBoardOrgAccess. Flow: name gate → whitelist gate →
   * dedup → Gemini classify → (if task) upsert work_item → insert raw message.
   */
  router.post("/agnb/whatsapp/ingest", async (req, res) => {
    const token = process.env.WHATSAPP_SIDECAR_TOKEN;
    const auth = req.header("authorization");
    if (!token || auth !== `Bearer ${token}`) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = (req.body ?? {}) as {
      wa_message_id?: string;
      group_jid?: string;
      group_name?: string;
      sender_phone?: string;
      sender_name?: string;
      body?: string;
    };
    if (!body.group_jid || !body.body?.trim()) {
      return res.status(400).json({ ok: false, error: "group_jid + body required" });
    }

    const waId = body.wa_message_id ?? null;
    const groupJid = body.group_jid;
    const groupName = body.group_name ?? null;
    const senderPhone = body.sender_phone ?? null;
    const senderName = body.sender_name ?? null;
    const text = body.body.trim();

    // Helper: log a raw message (no Gemini, no work item) so the Settings
    // "Recent messages" feed populates even for pending/disabled groups.
    const logRaw = async (note: string) => {
      if (waId) {
        const dupe = rows<{ id: string }>(
          await db.execute(sql`SELECT id FROM agnb.whatsapp_messages WHERE wa_message_id = ${waId} LIMIT 1`)
        )[0];
        if (dupe) return;
      }
      await db.execute(sql`
        INSERT INTO agnb.whatsapp_messages
          (wa_message_id, group_jid, group_name, sender_phone, sender_name, body,
           is_task, extracted, processed_at)
        VALUES (
          ${waId}, ${groupJid}, ${groupName}, ${senderPhone}, ${senderName}, ${text},
          false, ${JSON.stringify({ note })}::jsonb, now()
        )
      `);
    };

    // Name gate — only ingest groups whose name matches WA_GROUP_NAME_PREFIX.
    const namePrefix = (process.env.WA_GROUP_NAME_PREFIX ?? "finn").toLowerCase();
    if (namePrefix && !(groupName ?? "").trim().toLowerCase().startsWith(namePrefix)) {
      return res.json({ ok: true, skipped: "group name not whitelisted" });
    }

    // Whitelist gate — only process enabled groups.
    const grp = rows<{ enabled: boolean }>(
      await db.execute(sql`SELECT enabled FROM agnb.whatsapp_groups WHERE jid = ${groupJid} LIMIT 1`)
    )[0];
    const autoEnable = process.env.WA_AUTO_ENABLE === "1";
    if (!grp) {
      await db.execute(sql`
        INSERT INTO agnb.whatsapp_groups (jid, name, enabled)
        VALUES (${groupJid}, ${groupName}, ${autoEnable})
        ON CONFLICT (jid) DO NOTHING
      `);
      if (!autoEnable) {
        await logRaw("group pending approval");
        return res.json({ ok: true, skipped: "group pending approval" });
      }
      // autoEnable → fall through to classify this first message too
    } else if (grp.enabled === false) {
      await logRaw("group disabled");
      return res.json({ ok: true, skipped: "group disabled" });
    }

    // Dedupe
    if (waId) {
      const existing = rows<{ id: string }>(
        await db.execute(sql`SELECT id FROM agnb.whatsapp_messages WHERE wa_message_id = ${waId} LIMIT 1`)
      )[0];
      if (existing) return res.json({ ok: true, skipped: "duplicate" });
    }

    // Resolve known members for assignee hinting.
    const members = rows<{ id: string; name: string }>(
      await db.execute(sql`SELECT id, name FROM agnb.team_members WHERE active = true`)
    );
    const memberNames = members.map((m) => m.name);

    // Gemini classify
    const extracted = await extractWhatsAppWork({
      body: text,
      senderName: senderName ?? undefined,
      groupName: groupName ?? undefined,
      knownMembers: memberNames,
    });

    let workItemId: string | null = null;
    if (extracted.is_task && extracted.title) {
      // Resolve assignee: match hint against member names.
      let assignedTo: string | null = null;
      if (extracted.assignee_hint) {
        const hint = extracted.assignee_hint.replace(/^@/, "").toLowerCase();
        const match = members.find(
          (m) => m.name.toLowerCase().includes(hint) || hint.includes(m.name.toLowerCase().split(" ")[0])
        );
        assignedTo = match?.id ?? null;
      }
      const refId = waId ?? `${groupJid}:${Date.now()}`;
      const payload = JSON.stringify({
        source: "whatsapp",
        group: groupName,
        sender: senderName,
        due_hint: extracted.due_hint,
        raw: text.slice(0, 500),
      });
      const assignedAt = assignedTo ? new Date().toISOString() : null;
      const status = assignedTo ? "in_progress" : "queued";
      const wi = rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO agnb.work_items
            (kind, ref_table, ref_id, title, priority, assigned_to, assigned_at, status, payload)
          VALUES (
            'whatsapp.task', 'whatsapp_messages', ${refId}, ${extracted.title}, ${extracted.priority},
            ${assignedTo}, ${assignedAt}, ${status}, ${payload}::jsonb
          )
          ON CONFLICT (kind, ref_table, ref_id) DO UPDATE SET
            title = EXCLUDED.title, priority = EXCLUDED.priority,
            payload = EXCLUDED.payload, updated_at = now()
          RETURNING id
        `)
      )[0];
      workItemId = wi?.id ?? null;
    }

    // Log raw message
    await db.execute(sql`
      INSERT INTO agnb.whatsapp_messages
        (wa_message_id, group_jid, group_name, sender_phone, sender_name, body,
         is_task, extracted, work_item_id, processed_at)
      VALUES (
        ${waId}, ${groupJid}, ${groupName}, ${senderPhone}, ${senderName}, ${text},
        ${extracted.is_task}, ${JSON.stringify(extracted)}::jsonb, ${workItemId}, now()
      )
    `);

    res.json({ ok: true, is_task: extracted.is_task, work_item_id: workItemId });
  });
}
