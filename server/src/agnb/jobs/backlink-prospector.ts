import { sql } from "drizzle-orm";
import { geminiFindProspects, openPageRank } from "../lib/backlink-discovery.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * backlink-prospector — for each active competitor:
 *  1. Pull top topics from its analyzed agnb.competitor_blogs
 *  2. Ask Gemini for candidate referring domains likely to link to us
 *  3. Dedupe vs existing agnb.backlinks (skip domains we already have)
 *  4. Insert into agnb.backlink_prospects
 *  5. Enrich w/ OpenPageRank if OPENPAGERANK_API_KEY set
 *
 * Ported from agnb api/internal/backlink-prospector. Bearer CRON_SECRET gate
 * removed. Requires GEMINI_API_KEY (no-ops gracefully if missing —
 * geminiFindProspects returns []). OPENPAGERANK_API_KEY optional.
 * Cadence: daily.
 */
const MAX_COMPETITORS_PER_RUN = 5;
const TOPICS_PER_COMPETITOR = 3;

export async function backlinkProspector(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, log } = ctx;

  if (!process.env.GEMINI_API_KEY) {
    return { ok: true, summary: "skipped: GEMINI_API_KEY not set" };
  }

  const ourDomain = "hirefinn.ai";

  // Existing acquired backlinks — to dedupe
  const existingAcquired = rows<{ source_domain: string }>(
    await db.execute(sql`SELECT source_domain FROM agnb.backlinks`),
  );
  const acquiredSet = new Set(existingAcquired.map((r) => r.source_domain.toLowerCase()));

  const competitors = rows<{ id: string; name: string; domain: string }>(
    await db.execute(sql`
      SELECT id, name, domain FROM agnb.competitors
      WHERE status = 'active'
      LIMIT ${MAX_COMPETITORS_PER_RUN}
    `),
  );

  if (competitors.length === 0) return { ok: true, processed: 0, summary: "no active competitors" };

  const results: Array<Record<string, unknown>> = [];
  const allNewDomains: string[] = [];

  for (const c of competitors) {
    if (ctx.signal.aborted) break;

    // Pull topic-tagged analyzed blogs for this competitor
    const blogs = rows<{ topics: string[] | null }>(
      await db.execute(sql`
        SELECT topics FROM agnb.competitor_blogs
        WHERE competitor_id = ${c.id}
          AND analysis_status = 'analyzed'
          AND topics IS NOT NULL
        ORDER BY scraped_at DESC
        LIMIT 20
      `),
    );

    // Collect top topics for this competitor
    const topicCounts = new Map<string, number>();
    for (const b of blogs) {
      for (const t of b.topics ?? []) {
        topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
      }
    }
    const topTopics = Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOPICS_PER_COMPETITOR)
      .map(([t]) => t);

    if (topTopics.length === 0) {
      results.push({ competitor: c.name, status: "no_topics_yet" });
      continue;
    }

    let inserted = 0;
    for (const topic of topTopics) {
      if (ctx.signal.aborted) break;
      const candidates = await geminiFindProspects({ competitor: c.domain, topic, ourDomain });
      for (const domain of candidates) {
        const norm = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (acquiredSet.has(norm) || norm === ourDomain) continue;
        if (!allNewDomains.includes(norm)) allNewDomains.push(norm);

        const res = await db.execute(sql`
          INSERT INTO agnb.backlink_prospects
            (source_domain, referring_to, competitor_name, discovered_via, notes)
          VALUES
            (${norm}, ${c.domain}, ${c.name}, 'gemini-search', ${`topic: ${topic}`})
          ON CONFLICT (source_domain, referring_to) DO NOTHING
        `);
        if (((res as { rowCount?: number })?.rowCount ?? 0) > 0) inserted++;
      }
    }
    results.push({ competitor: c.name, topics_used: topTopics.length, new_prospects: inserted });
    log("competitor prospected", { competitor: c.name, topics: topTopics.length, new_prospects: inserted });
  }

  // Enrich w/ OpenPageRank in one batch
  let ranksAdded = 0;
  if (allNewDomains.length > 0 && process.env.OPENPAGERANK_API_KEY) {
    const ranks = await openPageRank(allNewDomains);
    for (const [domain, rank] of Object.entries(ranks)) {
      if (ctx.signal.aborted) break;
      const res = await db.execute(sql`
        UPDATE agnb.backlink_prospects
        SET domain_rank = ${rank}, updated_at = now()
        WHERE source_domain = ${domain}
      `);
      if (((res as { rowCount?: number })?.rowCount ?? 0) > 0) ranksAdded++;
    }
  }

  return {
    ok: true,
    competitors_processed: results.length,
    new_domains: allNewDomains.length,
    ranks_enriched: ranksAdded,
    results,
    summary: `${allNewDomains.length} new domains, ${ranksAdded} ranks enriched`,
  };
}
