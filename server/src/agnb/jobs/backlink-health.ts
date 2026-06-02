import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * backlink-health — for every non-deleted agnb.backlinks row, GET the source URL:
 *   - status >= 400 → "broken"
 *   - 2xx but target_url not in body → "broken" (link removed)
 *   - target present with nofollow nearby → "nofollow_removed"
 *   - otherwise → "live"
 *
 * Updates agnb.backlinks.status and writes a history row to
 * agnb.backlink_checks (backlink_id, status, http_status) for trend tracking.
 *
 * Ported from agnb api/internal/backlink-health. Bearer CRON_SECRET gate
 * removed. No external keys — pure crawl. Cadence: daily / 6h.
 */
const CONCURRENCY = 8;

interface BacklinkRow {
  id: string;
  source_url: string;
  target_url: string;
  status: string | null;
}

export async function backlinkHealth(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, log } = ctx;

  const backlinks = rows<BacklinkRow>(
    await db.execute(sql`
      SELECT id, source_url, target_url, status
      FROM agnb.backlinks
      WHERE status IS DISTINCT FROM 'deleted'
      LIMIT 500
    `),
  );

  if (backlinks.length === 0) return { ok: true, summary: "no backlinks to check" };

  let checked = 0;
  let changed = 0;
  let broken = 0;
  const errors: Array<{ id: string; error: string }> = [];

  const queue = [...backlinks];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      if (ctx.signal.aborted) return;
      const row = queue.shift();
      if (!row) return;
      try {
        const res = await fetch(row.source_url, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": "AGNB-backlink-checker/1.0 (+https://hirefinn.ai)" },
          signal: AbortSignal.timeout(15_000),
        });
        const httpStatus = res.status;
        let newStatus: string;
        if (res.status >= 400) {
          newStatus = "broken";
        } else {
          const body = (await res.text()).toLowerCase();
          const target = row.target_url.toLowerCase();
          const targetBase = target.replace(/\/$/, "").split("?")[0];
          const has = body.includes(targetBase);
          if (!has) {
            newStatus = "broken";
          } else {
            const idx = body.indexOf(targetBase);
            const window = body.slice(Math.max(0, idx - 200), idx + 200);
            newStatus = /nofollow/.test(window) ? "nofollow_removed" : "live";
          }
        }
        checked += 1;

        // History row for trend tracking
        await db.execute(sql`
          INSERT INTO agnb.backlink_checks (backlink_id, status, http_status)
          VALUES (${row.id}, ${newStatus}, ${httpStatus})
        `);

        if (newStatus !== row.status) {
          changed += 1;
          if (newStatus === "broken") broken += 1;
          await db.execute(sql`
            UPDATE agnb.backlinks SET status = ${newStatus} WHERE id = ${row.id}
          `);
        }
      } catch (e) {
        errors.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  log("backlink health done", { checked, changed, broken, errors: errors.length });

  return {
    ok: true,
    checked,
    changed,
    broken,
    errors: errors.slice(0, 10),
    summary: `${checked} checked, ${changed} changed, ${broken} broken`,
  };
}
