import { sql } from "drizzle-orm";
import { getSignupFunnel, getTrafficSources, getTopPages } from "../lib/posthog.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * posthog-sync — PostHog → agnb mirror. Ported from agnb api/internal/posthog-sync.
 *
 * Pulls the 24h signup funnel + traffic-source + top-page snapshots and writes
 * the funnel steps into agnb.funnel_snapshots (the table the UI reads via
 * /api/agnb/funnel). Traffic sources + top pages are stashed in the `raw`
 * jsonb of the first funnel step so dashboards can trend them without
 * re-querying PostHog.
 *
 * Translation notes vs the agnb route:
 *   - Source wrote a single funnel_log row per (snapshot_day, kind); here we
 *     write per funnel step into funnel_snapshots, which is what the ported UI
 *     consumes. Re-run safe: today's rows for funnel_key='signup' are deleted
 *     and re-inserted.
 *   - No CRON_SECRET gate. If PostHog keys are missing, getSignupFunnel /
 *     getTrafficSources / getTopPages throw, each is caught by allSettled, and
 *     the step no-ops.
 *
 * Cadence: hourly.
 * requiresEnv: POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY (host optional).
 */
export async function posthogSync(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const day = new Date().toISOString().slice(0, 10);

  const [funnelR, sourcesR, pagesR] = await Promise.allSettled([
    getSignupFunnel(1),
    getTrafficSources(1),
    getTopPages(1, 25),
  ]);

  const funnel = funnelR.status === "fulfilled" ? funnelR.value : null;
  const sources = sourcesR.status === "fulfilled" ? sourcesR.value : null;
  const pages = pagesR.status === "fulfilled" ? pagesR.value : null;

  const errors = [funnelR, sourcesR, pagesR]
    .map((r, i) => (r.status === "rejected" ? { idx: i, reason: String(r.reason) } : null))
    .filter(Boolean);

  if (!funnel && !sources && !pages) {
    ctx.log("all posthog queries failed", { errors });
    return { ok: false, processed: 0, summary: "all PostHog queries failed", errors };
  }

  const captured: string[] = [];
  let stepsWritten = 0;

  if (funnel && funnel.length > 0) {
    if (ctx.signal.aborted) return { ok: false, summary: "aborted" };
    // Re-run safe: clear today's signup funnel rows before re-inserting.
    await db.execute(sql`
      DELETE FROM agnb.funnel_snapshots
      WHERE funnel_key = 'signup' AND snapshot_date = ${day}
    `);
    for (let i = 0; i < funnel.length; i++) {
      if (ctx.signal.aborted) break;
      const step = funnel[i]!;
      // Stash auxiliary snapshots on the first step's raw payload.
      const raw =
        i === 0
          ? JSON.stringify({
              conversion_pct: step.conversion_pct,
              traffic_sources: sources ?? undefined,
              top_pages: pages ?? undefined,
            })
          : JSON.stringify({ conversion_pct: step.conversion_pct });
      await db.execute(sql`
        INSERT INTO agnb.funnel_snapshots
          (funnel_key, step_name, step_order, count, snapshot_date, raw)
        VALUES ('signup', ${step.step}, ${i}, ${step.count}, ${day}, ${raw}::jsonb)
      `);
      stepsWritten++;
    }
    captured.push("funnel");
  }
  if (sources) captured.push("traffic_sources");
  if (pages) captured.push("top_pages");

  ctx.log("posthog sync done", { day, captured, stepsWritten, errors });
  return {
    ok: true,
    processed: stepsWritten,
    snapshot_day: day,
    captured,
    errors,
    summary: `${captured.join(", ") || "nothing"} captured`,
  };
}
