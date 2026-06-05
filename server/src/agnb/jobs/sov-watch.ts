import { sql } from "drizzle-orm";
import { notify } from "../lib/notify.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const DROP_PTS_THRESHOLD = 15;
const MIN_RUNS = 5;

/**
 * sov-watch — producer→consumer loop on share-of-voice. The SoV Monitor agent
 * fills agnb.sov_results; this compares the brand-mention rate over the last 7
 * days vs the prior 7 and, on a material drop (>=15 pts), raises a notification
 * (HQ feed + Slack/email) so the CMO acts. Deduped to one alert per day.
 *
 * Cadence: daily. No external deps.
 */
export async function sovWatch(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const now = Date.now();
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const d14 = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();

  const agg = rows<{
    recent_total: number;
    recent_hit: number;
    prior_total: number;
    prior_hit: number;
  }>(
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ran_at >= ${d7})::int AS recent_total,
        count(*) FILTER (WHERE ran_at >= ${d7} AND brand_mentioned)::int AS recent_hit,
        count(*) FILTER (WHERE ran_at >= ${d14} AND ran_at < ${d7})::int AS prior_total,
        count(*) FILTER (WHERE ran_at >= ${d14} AND ran_at < ${d7} AND brand_mentioned)::int AS prior_hit
      FROM agnb.sov_results
    `),
  )[0];

  if (!agg || agg.recent_total < MIN_RUNS || agg.prior_total < MIN_RUNS) {
    return { ok: true, alerted: false, summary: "not enough SoV data to compare" };
  }

  const recent = agg.recent_hit / agg.recent_total;
  const prior = agg.prior_hit / agg.prior_total;
  const dropPts = Math.round((prior - recent) * 100);

  if (dropPts < DROP_PTS_THRESHOLD) {
    return { ok: true, alerted: false, recentRate: Math.round(recent * 100), summary: `SoV stable at ${Math.round(recent * 100)}%` };
  }

  const today = new Date().toISOString().slice(0, 10);
  const already = rows(
    await db.execute(sql`SELECT 1 FROM agnb.notifications WHERE kind = 'sov_drop' AND source_id = ${today} LIMIT 1`),
  );
  if (already.length > 0) {
    return { ok: true, alerted: false, summary: "SoV drop already alerted today" };
  }

  await notify(db, {
    kind: "sov_drop",
    severity: "warn",
    title: `Share of voice dropped ${dropPts} pts`,
    body: `Brand mention rate fell from ${Math.round(prior * 100)}% to ${Math.round(recent * 100)}% week-over-week across ${agg.recent_total} runs.`,
    link: "/sov",
    source_kind: "sov",
    source_id: today,
  });
  ctx.log(`sov-watch alerted: SoV down ${dropPts} pts`);
  return { ok: true, alerted: true, dropPts, summary: `alerted: share of voice down ${dropPts} pts` };
}
