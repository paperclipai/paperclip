import { sql } from "drizzle-orm";
import { postToLinkedIn, posterConfigured } from "../lib/linkedin-sidecar.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * linkedin-poster — ported from agnb api/internal/linkedin-poster.
 *
 * Finds agnb.linkedin_post_queue rows with status='scheduled' and
 * scheduled_at <= now(). For each:
 *   - If LinkedIn posting is configured (LINKEDIN_ACCESS_TOKEN + author URN,
 *     or LINKEDIN_SIDECAR_URL) → publish, mark 'posted'.
 *   - Else → set status='ready-to-post-manual' (operator copies manually).
 * Failures get error_message + status='failed' for retry.
 */
export async function linkedinPoster(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;

  const dueRows = rows<{ id: string; content: string }>(
    await db.execute(sql`
      SELECT id, content FROM agnb.linkedin_post_queue
      WHERE status = 'scheduled' AND scheduled_at <= now()
      ORDER BY scheduled_at ASC
      LIMIT 10
    `)
  );
  if (dueRows.length === 0) return { ok: true, processed: 0, summary: "no due posts" };

  const canPost = posterConfigured();
  const results: Array<Record<string, unknown>> = [];

  for (const row of dueRows) {
    if (ctx.signal.aborted) break;

    if (!canPost) {
      // Manual mode: bump status so operator picks up via UI.
      await db.execute(sql`
        UPDATE agnb.linkedin_post_queue
        SET status = 'ready-to-post-manual',
            error_message = 'LINKEDIN_* not set — copy content manually',
            updated_at = now()
        WHERE id = ${row.id}
      `);
      results.push({ id: row.id, status: "manual" });
      continue;
    }

    const r = await postToLinkedIn(row.content);
    if (r.ok) {
      await db.execute(sql`
        UPDATE agnb.linkedin_post_queue
        SET status = 'posted', posted_at = now(), linkedin_post_url = ${r.url ?? null},
            error_message = NULL, updated_at = now()
        WHERE id = ${row.id}
      `);
      results.push({ id: row.id, status: "posted", url: r.url });
    } else {
      await db.execute(sql`
        UPDATE agnb.linkedin_post_queue
        SET status = 'failed', error_message = ${r.error ?? "unknown error"}, updated_at = now()
        WHERE id = ${row.id}
      `);
      results.push({ id: row.id, status: "failed", error: r.error });
    }
  }

  ctx.log("linkedin poster done", { due: dueRows.length, manual: !canPost });
  return {
    ok: true,
    processed: results.length,
    due: dueRows.length,
    results,
    summary: canPost ? `${results.length} posts processed` : `${results.length} flagged for manual posting`,
  };
}
