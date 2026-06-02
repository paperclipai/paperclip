import { sql } from "drizzle-orm";
import { getInbox, hasRocketKey } from "../lib/rocketsdr-client.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * inbox-sync — pull the Rocket SDR inbox feed and upsert each thread into
 * agnb.rocket_inbox (the snapshot table the dashboard reads from, see
 * groups/inbox.ts). Dedup is by primary key (thread_id): existing rows are
 * refreshed in place, new threads inserted; archive columns are preserved on
 * conflict so a re-sync never resurrects an archived thread.
 *
 * Ported from agnb api/internal/inbox-sync. The original wrote into the
 * legacy internal.reply_log (rocket_inbox did not exist yet); the Paperclip
 * data model uses rocket_inbox, so we target it directly. The Bearer
 * CRON_SECRET gate is dropped (runs in-process).
 *
 * Env: ROCKETSDR_API_KEY (or ROCKET_MCP_TOKEN). No-ops if unset.
 */
const LIMIT = 100;

export async function inboxSync(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  if (!hasRocketKey()) return { ok: true, processed: 0, summary: "skipped: no key" };
  const { db } = ctx;

  const { threads } = await getInbox({ limit: LIMIT }, { db });

  let upserted = 0;
  const errors: Array<{ thread_id: string; error: string }> = [];

  for (const t of threads) {
    if (ctx.signal.aborted) break;
    const subject = t.subject ?? "(no subject)";
    const status = t.intent_label ?? "unknown";
    const preview = t.last_message_preview ?? subject;

    try {
      await db.execute(sql`
        INSERT INTO agnb.rocket_inbox
          (thread_id, subject, status, lead_email, lead_name, campaign_name,
           last_message_at, last_message_preview, raw, synced_at)
        VALUES (
          ${t.thread_id},
          ${subject},
          ${status},
          ${t.lead_email ?? null},
          ${t.lead_name ?? null},
          ${t.campaign_name ?? null},
          ${t.last_message_at ?? null},
          ${preview},
          ${JSON.stringify(t)}::jsonb,
          now()
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          subject = EXCLUDED.subject,
          status = EXCLUDED.status,
          lead_email = EXCLUDED.lead_email,
          lead_name = EXCLUDED.lead_name,
          campaign_name = EXCLUDED.campaign_name,
          last_message_at = EXCLUDED.last_message_at,
          last_message_preview = EXCLUDED.last_message_preview,
          raw = EXCLUDED.raw,
          synced_at = now()
      `);
      upserted += 1;
    } catch (e) {
      errors.push({ thread_id: t.thread_id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  ctx.log("inbox synced", { scanned: threads.length, upserted, errors: errors.length });
  return {
    ok: true,
    processed: upserted,
    scanned: threads.length,
    upserted,
    errors: errors.slice(0, 10),
    summary: `${upserted} threads`,
  };
}
