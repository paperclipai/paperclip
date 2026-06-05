import { sql } from "drizzle-orm";
import { notify } from "../lib/notify.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const WINDOW_DAYS = 3;
const MAX_PER_KIND = 10;

/**
 * negative-signal-watch — closes a producer→consumer loop on the reputation
 * side. The Reviews Monitor + Brand Monitor agents fill agnb.review_log and
 * agnb.community_mentions; this raises a notification (HQ feed + Slack/email
 * fan-out via notify()) for each NEW low-star review (<=3) and negative mention,
 * so a human / the CMO responds instead of the signal sitting on a dashboard.
 *
 * Idempotent: skips rows already notified (matched on source_kind + source_id).
 * Cadence: hourly. No required env (push channels are best-effort in notify()).
 */
export async function negativeSignalWatch(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let notified = 0;

  const reviews = rows<{
    platform: string;
    rating: number | null;
    excerpt: string | null;
    review_url: string;
  }>(
    await db.execute(sql`
      SELECT platform, rating, excerpt, review_url
      FROM agnb.review_log r
      WHERE r.rating IS NOT NULL AND r.rating <= 3
        AND r.review_url IS NOT NULL
        AND r.collected_at >= ${since}
        AND NOT EXISTS (
          SELECT 1 FROM agnb.notifications n
          WHERE n.source_kind = 'review' AND n.source_id = r.review_url
        )
      ORDER BY r.collected_at DESC
      LIMIT ${MAX_PER_KIND}
    `),
  );
  for (const r of reviews) {
    if (ctx.signal.aborted) break;
    await notify(db, {
      kind: "negative_review",
      severity: (r.rating ?? 3) <= 2 ? "critical" : "warn",
      title: `${r.rating}★ review on ${r.platform}`,
      body: r.excerpt ?? undefined,
      link: "/reviews",
      source_kind: "review",
      source_id: r.review_url,
    });
    notified++;
  }

  const mentions = rows<{ source: string; url: string; context: string | null }>(
    await db.execute(sql`
      SELECT source, url, context
      FROM agnb.community_mentions m
      WHERE m.sentiment IN ('negative', 'objection')
        AND m.noticed_at >= ${since}
        AND NOT EXISTS (
          SELECT 1 FROM agnb.notifications n
          WHERE n.source_kind = 'mention' AND n.source_id = m.url
        )
      ORDER BY m.noticed_at DESC
      LIMIT ${MAX_PER_KIND}
    `),
  );
  for (const m of mentions) {
    if (ctx.signal.aborted) break;
    await notify(db, {
      kind: "negative_mention",
      severity: "warn",
      title: `Negative mention on ${m.source}`,
      body: m.context ?? undefined,
      link: "/mentions",
      source_kind: "mention",
      source_id: m.url,
    });
    notified++;
  }

  ctx.log(`negative-signal-watch raised ${notified} notifications`);
  return { ok: true, notified, summary: `raised ${notified} negative-signal notifications` };
}
