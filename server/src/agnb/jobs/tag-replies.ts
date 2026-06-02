import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { hasGeminiKey } from "../lib/gemini.js";
import { tagReply } from "../lib/reply-tagger.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * tag-replies — re-tag every agnb.reply_log row where intent_confidence IS NULL.
 * Ported from agnb api/internal/tag-replies (GET cron mode). The POST one-shot
 * preview mode is API-only and not part of the scheduled job. Sequential to
 * stay under the Gemini per-minute quota.
 */
export async function tagReplies(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!hasGeminiKey()) return { ok: true, summary: "skipped: no GEMINI_API_KEY" };

  const replies = rows<{
    id: string;
    body: string;
    subject: string | null;
    from_email: string | null;
    from_name: string | null;
  }>(
    await db.execute(sql`
      SELECT id, body, subject, from_email, from_name
      FROM agnb.reply_log
      WHERE intent_confidence IS NULL
      LIMIT 50
    `),
  );

  if (replies.length === 0) return { ok: true, processed: 0, summary: "no untagged replies" };

  let tagged = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (const r of replies) {
    if (ctx.signal.aborted) break;
    try {
      const tag = await tagReply({
        body: r.body,
        subject: r.subject ?? undefined,
        from_email: r.from_email ?? undefined,
        from_name: r.from_name ?? undefined,
        signal: ctx.signal,
      });
      await db.execute(sql`
        UPDATE agnb.reply_log
        SET intent = ${tag.intent},
            intent_confidence = ${tag.confidence},
            objection_cluster = ${tag.objection_cluster},
            next_action = ${tag.next_action},
            notes = ${tag.summary}
        WHERE id = ${r.id}
      `);
      tagged++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ id: r.id, error: msg });
      ctx.log("tag-replies error", { id: r.id, error: msg });
    }
  }

  return { ok: true, processed: tagged, scanned: replies.length, tagged, errors, summary: `${tagged}/${replies.length} tagged` };
}
