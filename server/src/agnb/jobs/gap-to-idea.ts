import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

const MIN_GAP_SCORE = 60;
const MAX_PER_RUN = 5;

/**
 * gap-to-idea — closes the producer→consumer loop. The Competitor Watcher agent
 * (and the gap-analyzer job) fill agnb.content_gaps; this promotes the top
 * un-handled, high-score gaps into the Blog idea inbox (agnb.blog_ideas) so the
 * Blog project agents (Content Strategist → Blog Writer) pick them up and draft.
 *
 * Idempotent: a gap is marked status='promoted' once handled, and an idea is
 * only created if one for that topic+source doesn't already exist.
 *
 * Cadence: daily. No external deps.
 */
export async function gapToIdea(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const gapsR = await db.execute(sql`
    SELECT id, topic, gap_score, competitor_count, our_coverage_count, suggested_keywords
    FROM agnb.content_gaps
    WHERE status = 'identified' AND gap_score >= ${MIN_GAP_SCORE}
    ORDER BY gap_score DESC NULLS LAST
    LIMIT ${MAX_PER_RUN}
  `);
  const gaps = rows<{
    id: string;
    topic: string;
    competitor_count: number | null;
    our_coverage_count: number | null;
    suggested_keywords: string[] | null;
  }>(gapsR);

  let promoted = 0;
  for (const g of gaps) {
    if (ctx.signal.aborted) break;
    const kw = Array.isArray(g.suggested_keywords) ? g.suggested_keywords.slice(0, 8).join(", ") : "";
    const rawText =
      `Content gap: "${g.topic}" — ${g.competitor_count ?? 0} competitors cover it, we have ${g.our_coverage_count ?? 0}. ` +
      `Draft a post that targets it.${kw ? ` Keywords: ${kw}.` : ""}`;

    await db.execute(sql`
      INSERT INTO agnb.blog_ideas (raw_text, source, related_topic, notes, status, created_by)
      SELECT ${rawText}, 'content-gap', ${g.topic}, ${kw || null}, 'inbox', 'gap-promoter'
      WHERE NOT EXISTS (
        SELECT 1 FROM agnb.blog_ideas WHERE related_topic = ${g.topic} AND source = 'content-gap'
      )
    `);
    await db.execute(sql`
      UPDATE agnb.content_gaps SET status = 'promoted', updated_at = now() WHERE id = ${g.id}
    `);
    promoted++;
  }

  ctx.log(`gap-to-idea promoted ${promoted} content gaps to the blog idea inbox`);
  return { ok: true, promoted, summary: `promoted ${promoted} content gaps to the blog idea inbox` };
}
