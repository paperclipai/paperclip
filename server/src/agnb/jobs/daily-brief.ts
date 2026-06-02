import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * daily-brief — compose the daily ops brief and persist to agnb.daily_briefs.
 * Ported from agnb api/internal/daily-brief.
 *
 * PARTIAL PORT. The agnb route also pulled live signal from three external
 * clients that are owned by other agents / live outside this jobs tree:
 *   - RocketSDR (listProducts/listPersonas)  → product/persona/draft/reply mix
 *   - HubSpot   (listDeals/listPipelines)    → open deals + weighted value
 *   - Cal.com   (listBookings)               → upcoming demos
 * Those sources are omitted here; the OUTBOUND/PIPELINE numbers that depended
 * purely on them are dropped, and draft/reply counts are read from the
 * agnb tables instead. Re-wire the external clients in a later phase.
 *
 * Email delivery (Resend) is also dropped — notification fan-out is handled by
 * the notification-dispatcher job + notify() helper. This job only persists
 * the brief row; the UI reads agnb.daily_briefs.
 *
 * Translation notes:
 *   - supabase internal.* → ctx.db.execute(sql`... FROM agnb.* ...`)
 *   - No CRON_SECRET gate.
 *
 * Cadence: daily.
 * requiresEnv: none (pure DB).
 */
export async function dailyBrief(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const today = new Date().toISOString().slice(0, 10);
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  if (ctx.signal.aborted) return { ok: false, summary: "aborted" };

  const [replyRes, mentionRes, backlinkRes, draftRes, sovRes, bofuRes, bucketRes, expRes] =
    await Promise.all([
      db.execute(sql`
        SELECT intent, objection_cluster, received_at
        FROM agnb.reply_log WHERE received_at >= ${dayAgo}
      `),
      db.execute(sql`
        SELECT source, sentiment, noticed_at
        FROM agnb.community_mentions WHERE noticed_at >= ${weekAgo}
      `),
      db.execute(sql`
        SELECT source_domain, acquired_at, kind
        FROM agnb.backlinks WHERE acquired_at >= ${weekAgo}
      `),
      db.execute(sql`
        SELECT status, created_at
        FROM agnb.campaign_drafts WHERE created_at >= ${dayAgo}
      `),
      db.execute(sql`
        SELECT brand_mentioned, position, ran_at
        FROM agnb.sov_results WHERE ran_at >= ${weekAgo}
      `),
      db.execute(sql`
        SELECT status, current_rank
        FROM agnb.bofu_pages WHERE status IN ('ranking', 'top10', 'top3')
      `),
      db.execute(sql`
        SELECT id, name, status, estimated_leads
        FROM agnb.experiment_buckets WHERE status IN ('running', 'proposed')
      `),
      db.execute(sql`
        SELECT title, metric, started_at, outcome, ended_at
        FROM agnb.experiments WHERE started_at >= ${dayAgo}
      `),
    ]);

  const replies = rows<{ intent: string }>(replyRes);
  const mentions = rows<{ source: string; sentiment: string | null }>(mentionRes);
  const backlinks = rows(backlinkRes);
  const drafts = rows<{ status: string }>(draftRes);
  const sovs = rows<{ brand_mentioned: boolean }>(sovRes);
  const ranking = rows(bofuRes);
  const activeBuckets = rows<{ name: string; status: string; estimated_leads: number | null }>(
    bucketRes,
  );
  const experiments = rows<{ title: string; metric: string }>(expRes);

  const interestedReplies = replies.filter((r) => r.intent === "interested").length;
  const objectionReplies = replies.filter((r) => r.intent === "objection").length;
  const mentionSources = new Set(mentions.map((m) => m.source)).size;
  const positiveMentions = mentions.filter((m) => m.sentiment === "positive").length;
  const pendingDrafts = drafts.filter((d) => d.status === "pending" || d.status === "draft").length;
  const finalizedDrafts = drafts.filter((d) => d.status === "finalized").length;
  const sovMentionRate = sovs.length
    ? Math.round((sovs.filter((s) => s.brand_mentioned).length / sovs.length) * 100)
    : 0;

  const headline = `Brief · ${today}`;
  const sections: string[] = [];

  sections.push(
    `OUTBOUND · Drafts & replies`,
    `  ${pendingDrafts} drafts pending review · ${finalizedDrafts} finalized in 24h`,
    `  ${replies.length} replies logged in 24h (${interestedReplies} interested · ${objectionReplies} objections)`,
  );

  sections.push(
    `\nINBOUND · Brand`,
    `  ${mentions.length} community mentions logged this week (${mentionSources} sources · ${positiveMentions} positive)`,
    `  ${backlinks.length} backlinks acquired this week`,
    `  LLM share-of-voice: ${sovMentionRate}% mention rate across ${sovs.length} runs (7d)`,
    `  ${ranking.length} BoFu pages currently ranking`,
  );

  if (experiments.length > 0) {
    sections.push(
      `\nEXPERIMENTS (24h)`,
      ...experiments.map((e) => `  • ${e.title} — ${e.metric}`),
    );
  } else {
    sections.push(`\nEXPERIMENTS — none logged in 24h. Pick one to test today.`);
  }

  if (activeBuckets.length > 0) {
    const running = activeBuckets.filter((b) => b.status === "running");
    const proposed = activeBuckets.filter((b) => b.status === "proposed");
    const totalReach = activeBuckets.reduce((s, b) => s + (b.estimated_leads ?? 0), 0);
    sections.push(
      `\nBUCKETS — ${running.length} running · ${proposed.length} proposed · ${totalReach.toLocaleString()} est. lead reach`,
      ...running
        .slice(0, 5)
        .map((b) => `  • ${b.name} (${(b.estimated_leads ?? 0).toLocaleString()} leads)`),
    );
  } else {
    sections.push(`\nBUCKETS — none active. Define an ICP at /buckets/new.`);
  }

  const body = sections.join("\n");

  await db.execute(sql`
    INSERT INTO agnb.daily_briefs (headline, body, generated_at)
    VALUES (${headline}, ${body}, now())
  `);

  ctx.log("daily brief generated", {
    today,
    replies: replies.length,
    mentions: mentions.length,
    experiments: experiments.length,
    buckets: activeBuckets.length,
  });

  return { ok: true, processed: 1, headline, summary: headline };
}
