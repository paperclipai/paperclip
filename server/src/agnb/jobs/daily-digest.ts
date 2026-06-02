import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * daily-digest — capture today's metric snapshot, flag anomalies vs the 7-day
 * avg (>30% deviation), and ask Gemini for a 1-paragraph digest. Persists into
 * agnb.daily_metrics_snapshots (upsert by snapshot_date).
 * Ported from agnb api/internal/daily-digest.
 *
 * Translation notes:
 *   - supabase internal.* count/select queries → ctx.db.execute(sql`...`)
 *     against agnb.*. Counts use COUNT(*) instead of head+count.
 *   - jsonb columns (metrics, anomalies) written as JSON.stringify + ::jsonb.
 *   - No CRON_SECRET gate.
 *   - Gemini call no-ops (returns "") when GEMINI_API_KEY is missing.
 *
 * Cadence: daily.
 * requiresEnv: none required (GEMINI_API_KEY optional → digest text empty if absent).
 */

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface Anomaly {
  metric: string;
  today: number;
  wow_pct: number;
  severity: string;
}

async function geminiSummarize(
  today: Record<string, number>,
  anomalies: Anomaly[],
  signal: AbortSignal,
): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "";
  const prompt = `You are writing a 1-paragraph daily ops digest for Finn's leadership.

TODAY'S METRICS (snapshot ${isoDate(new Date())}):
${Object.entries(today)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

ANOMALIES vs 7-day avg (only items with >30% deviation):
${
  anomalies.length === 0
    ? "(none)"
    : anomalies
        .map(
          (a) =>
            `- ${a.metric}: today ${a.today}, ${a.wow_pct > 0 ? "+" : ""}${a.wow_pct.toFixed(0)}% vs avg [${a.severity}]`,
        )
        .join("\n")
}

Write a 3-sentence paragraph. Sentence 1: highlight the most important number (anomaly first, else top metric). Sentence 2: explain if there's a likely cause. Sentence 3: suggest ONE specific operator action for today.

No "we are excited" or "great progress". Direct. Plain text. No markdown.`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 400,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      },
    );
    if (!r.ok) return "";
    const j = (await r.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  } catch {
    return "";
  }
}

export async function dailyDigest(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const today = isoDate(new Date());
  const weekAgoIso = new Date(Date.now() - 7 * 86_400_000).toISOString();

  if (ctx.signal.aborted) return { ok: false, summary: "aborted" };

  const countRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM agnb.blog_drafts) AS blogs_total,
      (SELECT COUNT(*) FROM agnb.blog_drafts WHERE status = 'scheduled') AS blogs_scheduled,
      (SELECT COUNT(*) FROM agnb.blog_drafts WHERE status = 'published') AS blogs_published,
      (SELECT COUNT(*) FROM agnb.blog_drafts WHERE status = 'failed') AS blogs_failed,
      (SELECT COUNT(*) FROM agnb.content_gaps WHERE status = 'identified') AS gaps_pending,
      (SELECT COUNT(*) FROM agnb.content_gaps WHERE status = 'drafted') AS gaps_drafted,
      (SELECT COUNT(*) FROM agnb.filled_assets) AS customer_fills,
      (SELECT COUNT(*) FROM agnb.topup_links) AS topups_total,
      (SELECT COALESCE(SUM(total_paise), 0) FROM agnb.topup_links WHERE status = 'paid') AS topups_paid_paise,
      (SELECT COUNT(*) FROM agnb.crm_hygiene_issues WHERE resolved_at IS NULL) AS crm_open_issues,
      (SELECT COUNT(*) FROM agnb.competitor_blogs WHERE scraped_at >= ${weekAgoIso}) AS competitor_blogs_7d,
      (SELECT COUNT(*) FROM agnb.backlink_prospects WHERE discovered_at >= ${weekAgoIso}) AS new_backlink_prospects_7d
  `);
  const c = rows<Record<string, string | number>>(countRes)[0] ?? {};
  const num = (k: string) => Number(c[k] ?? 0);

  const metrics: Record<string, number> = {
    blogs_total: num("blogs_total"),
    blogs_scheduled: num("blogs_scheduled"),
    blogs_published: num("blogs_published"),
    blogs_failed: num("blogs_failed"),
    gaps_pending: num("gaps_pending"),
    gaps_drafted: num("gaps_drafted"),
    customer_fills: num("customer_fills"),
    topups_total: num("topups_total"),
    topups_paid_inr: Math.round(num("topups_paid_paise") / 100),
    crm_open_issues: num("crm_open_issues"),
    competitor_blogs_7d: num("competitor_blogs_7d"),
    new_backlink_prospects_7d: num("new_backlink_prospects_7d"),
  };

  // Anomalies vs 7-day avg from prior snapshots.
  const historyRes = await db.execute(sql`
    SELECT metrics FROM agnb.daily_metrics_snapshots
    WHERE snapshot_date < ${today}
    ORDER BY snapshot_date DESC LIMIT 7
  `);
  const history = rows<{ metrics: Record<string, number> }>(historyRes);

  const anomalies: Anomaly[] = [];
  if (history.length >= 3) {
    const avgs: Record<string, number> = {};
    for (const k of Object.keys(metrics)) {
      const vals = history
        .map((h) => Number(h.metrics?.[k] ?? 0))
        .filter((v) => Number.isFinite(v));
      avgs[k] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }
    for (const [k, v] of Object.entries(metrics)) {
      const avg = avgs[k] ?? 0;
      if (avg === 0) continue;
      const wow = ((v - avg) / avg) * 100;
      if (Math.abs(wow) >= 30) {
        anomalies.push({
          metric: k,
          today: v,
          wow_pct: wow,
          severity: Math.abs(wow) >= 70 ? "high" : "med",
        });
      }
    }
  }

  const digest = await geminiSummarize(metrics, anomalies, ctx.signal);

  await db.execute(sql`
    INSERT INTO agnb.daily_metrics_snapshots (snapshot_date, metrics, anomalies, digest_text)
    VALUES (
      ${today},
      ${JSON.stringify(metrics)}::jsonb,
      ${JSON.stringify(anomalies)}::jsonb,
      ${digest || null}
    )
    ON CONFLICT (snapshot_date) DO UPDATE SET
      metrics = EXCLUDED.metrics,
      anomalies = EXCLUDED.anomalies,
      digest_text = EXCLUDED.digest_text
  `);

  ctx.log("daily digest snapshot", {
    snapshot_date: today,
    anomalies: anomalies.length,
    history_size: history.length,
    digest_chars: digest.length,
  });

  return {
    ok: true,
    processed: 1,
    snapshot_date: today,
    metrics,
    anomalies,
    summary: `${anomalies.length} anomalies, ${history.length}d history`,
  };
}
