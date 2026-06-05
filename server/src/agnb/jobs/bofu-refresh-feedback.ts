import { sql } from "drizzle-orm";
import { notify } from "../lib/notify.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const RANK_FLOOR = 10; // worse than page-1
const MAX_PER_RUN = 5;

/**
 * bofu-refresh-feedback — outcome→action feedback loop. The BoFu Rank Monitor +
 * gsc-rank-tracker fill agnb.bofu_pages with live SERP rank/traffic. This finds
 * money pages that have slipped off page one and, for each, briefs a refresh
 * (agnb.content_briefs, stage 'backlog') so the Content Strategist / Blog Writer
 * acts, and alerts the CMO. Closes the loop: performance data drives the work.
 *
 * Idempotent: only pages with a primary_keyword and no existing refresh brief.
 * Daily. No external deps.
 */
export async function bofuRefreshFeedback(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const slipping = rows<{ title: string; url: string; primary_keyword: string; current_rank: number }>(
    await db.execute(sql`
      SELECT title, url, primary_keyword, current_rank
      FROM agnb.bofu_pages b
      WHERE b.current_rank IS NOT NULL AND b.current_rank > ${RANK_FLOOR}
        AND b.primary_keyword IS NOT NULL AND b.primary_keyword <> ''
        AND NOT EXISTS (
          SELECT 1 FROM agnb.content_briefs c
          WHERE c.content_type = 'refresh' AND c.primary_keyword = b.primary_keyword
        )
      ORDER BY b.current_rank ASC
      LIMIT ${MAX_PER_RUN}
    `),
  );

  let briefed = 0;
  for (const p of slipping) {
    if (ctx.signal.aborted) break;
    await db.execute(sql`
      INSERT INTO agnb.content_briefs (title, content_type, stage, primary_keyword, created_by)
      VALUES (${`Refresh: ${p.title}`}, 'refresh', 'backlog', ${p.primary_keyword}, 'bofu-feedback')
    `);
    await notify(db, {
      kind: "bofu_refresh",
      severity: "warn",
      title: `BoFu page "${p.title}" ranks #${p.current_rank} — refresh briefed`,
      body: `Primary keyword "${p.primary_keyword}" slipped off page one. A refresh brief was queued.`,
      link: "/bofu",
      source_kind: "bofu_refresh",
      source_id: p.primary_keyword,
    });
    briefed++;
  }

  ctx.log(`bofu-refresh-feedback briefed ${briefed} refreshes`);
  return { ok: true, briefed, summary: `briefed ${briefed} BoFu page refreshes` };
}
