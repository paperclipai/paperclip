import { sql } from "drizzle-orm";
import { extractWhatsAppWork, geminiConfigured } from "../lib/whatsapp-extract.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * whatsapp-intake — ported from agnb api/internal/whatsapp-intake.
 *
 * The agnb route was a webhook: the Baileys sidecar POSTed each whitelisted
 * group message (authed via WHATSAPP_SIDECAR_TOKEN), which then deduped,
 * gated on whatsapp_groups.enabled, Gemini-classified, and (if a task)
 * created a work_item.
 *
 * In the scheduler there is no inbound webhook, so this job ports the
 * processing half: every 15 min it picks up agnb.whatsapp_messages rows that
 * the sidecar logged raw but that have NOT been classified yet
 * (processed_at IS NULL), classifies them via Gemini, and creates work_items
 * for enabled groups. The sidecar is still responsible for inserting raw
 * rows + the WHATSAPP_SIDECAR_TOKEN-authed ingest; this job is the
 * downstream classifier.
 *
 * // PHASE 5: the raw-message ingest webhook has no in-process equivalent.
 * // The sidecar continues to insert into agnb.whatsapp_messages directly.
 *
 * Gated on GEMINI_API_KEY (classifier) — no-ops gracefully if unset.
 */
const WORK_KIND = "whatsapp.task";

export async function whatsappIntake(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!geminiConfigured()) {
    return { ok: true, summary: "skipped: GEMINI_API_KEY not set" };
  }

  // Pull unclassified raw messages (sidecar inserted them with no
  // processed_at). Cap per run to keep the 15-min cadence cheap.
  const pending = rows<{
    id: string;
    wa_message_id: string | null;
    group_jid: string;
    group_name: string | null;
    sender_phone: string | null;
    sender_name: string | null;
    body: string;
  }>(
    await db.execute(sql`
      SELECT id, wa_message_id, group_jid, group_name, sender_phone, sender_name, body
      FROM agnb.whatsapp_messages
      WHERE processed_at IS NULL
      ORDER BY received_at ASC
      LIMIT 50
    `)
  );
  if (pending.length === 0) return { ok: true, processed: 0, summary: "no unprocessed messages" };

  // Name gate + whitelist gate config (mirrors the agnb route).
  const namePrefix = (process.env.WA_GROUP_NAME_PREFIX ?? "finn").toLowerCase();

  // Resolve active members once for assignee hinting.
  const members = rows<{ id: string; name: string }>(
    await db.execute(sql`SELECT id, name FROM agnb.team_members WHERE active = true`)
  );
  const memberNames = members.map((m) => m.name);

  let classified = 0;
  let tasks = 0;
  let skipped = 0;

  for (const m of pending) {
    if (ctx.signal.aborted) break;

    // Name gate — only ingest groups whose name matches the prefix.
    if (namePrefix && !(m.group_name ?? "").trim().toLowerCase().startsWith(namePrefix)) {
      await db.execute(sql`
        UPDATE agnb.whatsapp_messages
        SET is_task = false, extracted = ${JSON.stringify({ note: "group name not whitelisted" })}::jsonb, processed_at = now()
        WHERE id = ${m.id}
      `);
      skipped++;
      continue;
    }

    // Whitelist gate — only process enabled groups. Auto-register unseen
    // groups (default disabled unless WA_AUTO_ENABLE=1).
    const grp = rows<{ enabled: boolean }>(
      await db.execute(sql`SELECT enabled FROM agnb.whatsapp_groups WHERE jid = ${m.group_jid}`)
    )[0];
    const autoEnable = process.env.WA_AUTO_ENABLE === "1";
    if (!grp) {
      await db.execute(sql`
        INSERT INTO agnb.whatsapp_groups (jid, name, enabled)
        VALUES (${m.group_jid}, ${m.group_name}, ${autoEnable})
        ON CONFLICT (jid) DO NOTHING
      `);
      if (!autoEnable) {
        await db.execute(sql`
          UPDATE agnb.whatsapp_messages
          SET is_task = false, extracted = ${JSON.stringify({ note: "group pending approval" })}::jsonb, processed_at = now()
          WHERE id = ${m.id}
        `);
        skipped++;
        continue;
      }
    } else if (grp.enabled === false) {
      await db.execute(sql`
        UPDATE agnb.whatsapp_messages
        SET is_task = false, extracted = ${JSON.stringify({ note: "group disabled" })}::jsonb, processed_at = now()
        WHERE id = ${m.id}
      `);
      skipped++;
      continue;
    }

    // Gemini classify.
    const extracted = await extractWhatsAppWork({
      body: m.body,
      senderName: m.sender_name ?? undefined,
      groupName: m.group_name ?? undefined,
      knownMembers: memberNames,
    });

    let workItemId: string | null = null;
    if (extracted.is_task && extracted.title) {
      // Resolve assignee: match hint against member names.
      let assignedTo: string | null = null;
      if (extracted.assignee_hint) {
        const hint = extracted.assignee_hint.replace(/^@/, "").toLowerCase();
        const match = members.find(
          (mem) => mem.name.toLowerCase().includes(hint) || hint.includes(mem.name.toLowerCase().split(" ")[0])
        );
        assignedTo = match?.id ?? null;
      }
      const refId = m.wa_message_id ?? `${m.group_jid}:${Date.now()}`;
      const payload = JSON.stringify({
        source: "whatsapp",
        group: m.group_name,
        sender: m.sender_name,
        due_hint: extracted.due_hint,
        raw: m.body.slice(0, 500),
      });
      const assignedAt = assignedTo ? new Date().toISOString() : null;
      const status = assignedTo ? "in_progress" : "queued";
      const wi = rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO agnb.work_items
            (kind, ref_table, ref_id, title, priority, assigned_to, assigned_at, status, payload)
          VALUES (
            ${WORK_KIND}, 'whatsapp_messages', ${refId}, ${extracted.title}, ${extracted.priority},
            ${assignedTo}, ${assignedAt}, ${status}, ${payload}::jsonb
          )
          ON CONFLICT (kind, ref_table, ref_id) DO UPDATE SET
            title = EXCLUDED.title, priority = EXCLUDED.priority, payload = EXCLUDED.payload, updated_at = now()
          RETURNING id
        `)
      )[0];
      workItemId = wi?.id ?? null;
      tasks++;
    }

    await db.execute(sql`
      UPDATE agnb.whatsapp_messages
      SET is_task = ${extracted.is_task},
          extracted = ${JSON.stringify(extracted)}::jsonb,
          work_item_id = ${workItemId},
          processed_at = now()
      WHERE id = ${m.id}
    `);
    classified++;
  }

  ctx.log("whatsapp intake done", { pending: pending.length, classified, tasks, skipped });
  return {
    ok: true,
    processed: classified,
    tasks_created: tasks,
    skipped,
    summary: `${classified} classified, ${tasks} tasks, ${skipped} skipped`,
  };
}
