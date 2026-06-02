import { sql } from "drizzle-orm";
import { fetchRssFeed } from "../lib/rss-parser.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * rss-sync — fetch all active feeds, parse items, upsert into agnb.rss_items,
 * update feed status. Ported from agnb api/internal/rss-sync. Polite 1 req/sec.
 */
export async function rssSync(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const feeds = rows<{ id: string; name: string; url: string }>(
    await db.execute(sql`SELECT id, name, url FROM agnb.rss_feeds WHERE status = 'active'`)
  );
  if (feeds.length === 0) return { ok: true, processed: 0, summary: "no active feeds" };

  const results: Array<Record<string, unknown>> = [];
  for (const f of feeds) {
    if (ctx.signal.aborted) break;
    try {
      const items = await fetchRssFeed(f.url);
      let inserted = 0;
      for (const item of items) {
        const r = await db.execute(sql`
          INSERT INTO agnb.rss_items (feed_id, feed_name, title, url, summary, published_at, fetched_at)
          VALUES (${f.id}, ${f.name}, ${item.title}, ${item.url}, ${item.summary}, ${item.published_at}, now())
          ON CONFLICT (url) DO NOTHING
        `);
        const n = (r as { rowCount?: number })?.rowCount ?? 0;
        if (n > 0) inserted++;
      }
      await db.execute(sql`
        UPDATE agnb.rss_feeds
        SET last_synced_at = now(), last_error = NULL, items_count = ${items.length}, updated_at = now()
        WHERE id = ${f.id}
      `);
      results.push({ feed: f.name, items: items.length, inserted });
      ctx.log(`feed synced`, { feed: f.name, items: items.length, inserted });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.execute(sql`
        UPDATE agnb.rss_feeds SET last_synced_at = now(), last_error = ${msg} WHERE id = ${f.id}
      `);
      results.push({ feed: f.name, error: msg });
      ctx.log(`feed error`, { feed: f.name, error: msg });
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return { ok: true, processed: results.length, results, summary: `${results.length} feeds` };
}
