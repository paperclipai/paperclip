import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { generateJson, hasGeminiKey } from "../lib/gemini.js";
import { googleSuggest } from "../lib/keyword-research.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * gap-analyzer — two-phase nightly job, ported from agnb api/internal/gap-analyzer.
 *
 *   Phase A: Gemini tags topics + keywords on pending agnb.competitor_blogs.
 *   Phase B: aggregate analyzed topics → gap scoring vs Finn's own coverage,
 *            upsert agnb.content_gaps.
 *   Phase C: enrich top-10 gaps with Google Suggest queries.
 *
 * Finn's own coverage is read from content/blog/*.mdx (absent on the Paperclip
 * server → finn_blog_count 0, every topic counts as uncovered).
 */

const MAX_ANALYZE_PER_RUN = 10;
const ANALYZE_CHUNK = 5;

interface GeminiTopicResp { topics?: string[]; keywords?: string[]; }

async function geminiExtractTopics(
  title: string,
  excerpt: string | null,
  signal: AbortSignal,
): Promise<{ topics: string[]; keywords: string[]; inTok: number; outTok: number }> {
  const prompt = `Analyze this blog post (likely from a voice-AI / contact-center vendor) and extract topic tags + SEO keywords.

TITLE: ${title}
${excerpt ? `EXCERPT: ${excerpt.slice(0, 1500)}` : ""}

Return ONLY JSON: { "topics": ["3-5 short topic tags, lowercase, hyphen-separated"], "keywords": ["5-8 SEO keywords or short phrases"] }
- topics example: "stir-shaken", "outbound-calling", "ai-voice-cost", "contact-center-ai"
- keywords example: "ai voice agent pricing", "twilio alternative", "outbound dial cost"
No preamble, no code fence.`;
  const { data, inTok, outTok } = await generateJson<GeminiTopicResp>(prompt, {
    temperature: 0.2,
    maxOutputTokens: 800,
    timeoutMs: 15_000,
    signal,
  });
  return {
    topics: Array.isArray(data.topics) ? data.topics : [],
    keywords: Array.isArray(data.keywords) ? data.keywords : [],
    inTok,
    outTok,
  };
}

async function loadFinnBlogs(): Promise<Array<{ title: string; path: string }>> {
  try {
    const dir = join(process.cwd(), "content", "blog");
    const files = await readdir(dir);
    const result: Array<{ title: string; path: string }> = [];
    for (const f of files) {
      if (!f.endsWith(".mdx")) continue;
      const text = await readFile(join(dir, f), "utf8");
      const t = text.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim();
      if (t) result.push({ title: t.toLowerCase(), path: `content/blog/${f}` });
    }
    return result;
  } catch {
    return [];
  }
}

export async function gapAnalyzer(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!hasGeminiKey()) return { ok: true, summary: "skipped: no GEMINI_API_KEY" };

  // ── Phase A: extract topics on unanalyzed competitor blogs ──────────────
  const pending = rows<{ id: string; title: string | null; content_excerpt: string | null }>(
    await db.execute(sql`
      SELECT id, title, content_excerpt
      FROM agnb.competitor_blogs
      WHERE analysis_status = 'pending' AND title IS NOT NULL
      ORDER BY scraped_at ASC
      LIMIT ${MAX_ANALYZE_PER_RUN}
    `),
  );

  let analyzed = 0, analyzeFailed = 0, usageIn = 0, usageOut = 0;

  const analyzeOne = async (blog: { id: string; title: string | null; content_excerpt: string | null }) => {
    try {
      const r = await geminiExtractTopics(blog.title!, blog.content_excerpt, ctx.signal);
      usageIn += r.inTok;
      usageOut += r.outTok;
      await db.execute(sql`
        UPDATE agnb.competitor_blogs
        SET topics = ${r.topics.slice(0, 8)}::text[],
            keywords = ${r.keywords.slice(0, 12)}::text[],
            analysis_status = 'analyzed'
        WHERE id = ${blog.id}
      `);
      analyzed++;
    } catch {
      await db.execute(sql`
        UPDATE agnb.competitor_blogs SET analysis_status = 'failed' WHERE id = ${blog.id}
      `);
      analyzeFailed++;
    }
  };

  for (let i = 0; i < pending.length; i += ANALYZE_CHUNK) {
    if (ctx.signal.aborted) break;
    await Promise.all(pending.slice(i, i + ANALYZE_CHUNK).map(analyzeOne));
  }

  // ── Phase B: aggregate topics → gap scoring ─────────────────────────────
  const allBlogs = rows<{
    topics: string[] | null;
    keywords: string[] | null;
    title: string | null;
    published_at: string | null;
  }>(
    await db.execute(sql`
      SELECT topics, keywords, title, published_at
      FROM agnb.competitor_blogs
      WHERE analysis_status = 'analyzed'
    `),
  );

  const topicMap = new Map<string, { count: number; titles: Set<string>; keywords: Set<string>; recentHit: boolean }>();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const b of allBlogs) {
    const isRecent = !!b.published_at && new Date(b.published_at).getTime() > cutoff;
    for (const t of b.topics ?? []) {
      const key = String(t).trim().toLowerCase();
      if (!key) continue;
      const cur = topicMap.get(key) ?? { count: 0, titles: new Set<string>(), keywords: new Set<string>(), recentHit: false };
      cur.count++;
      if (b.title) cur.titles.add(b.title);
      for (const k of b.keywords ?? []) cur.keywords.add(String(k));
      if (isRecent) cur.recentHit = true;
      topicMap.set(key, cur);
    }
  }

  const finnBlogs = await loadFinnBlogs();

  let gapsWritten = 0, refreshCount = 0;
  for (const [topic, agg] of topicMap.entries()) {
    if (agg.count < 2) continue;

    const matches = finnBlogs.filter((b) => b.title.includes(topic.replace(/-/g, " ")) || b.title.includes(topic));
    const ourCoverage = matches.length;
    const recencyBoost = agg.recentHit ? 5 : 0;
    const score = Math.max(0, Math.min(100, agg.count * 10 - ourCoverage * 25 + recencyBoost));
    const suggestionType = ourCoverage >= 1 ? "refresh" : "new";

    const topicWordCount = topic.replace(/-/g, " ").split(/\s+/).filter(Boolean).length;
    let clusterType: "pillar" | "spoke" | "standalone";
    if (topicWordCount <= 2 && agg.count >= 4) clusterType = "pillar";
    else if (topicWordCount >= 3) clusterType = "spoke";
    else clusterType = "standalone";

    let parentTopic: string | null = null;
    if (clusterType === "spoke") {
      const candidates = Array.from(topicMap.keys()).filter((t) => {
        const ws = t.replace(/-/g, " ").split(/\s+/).filter(Boolean).length;
        return ws <= 2 && topic.replace(/-/g, " ").includes(t.replace(/-/g, " "));
      });
      if (candidates.length > 0) {
        candidates.sort((a, b) => topicMap.get(b)!.count - topicMap.get(a)!.count);
        parentTopic = candidates[0];
      }
    }

    const suggestedKeywords = Array.from(agg.keywords).slice(0, 10);
    const representativeTitles = Array.from(agg.titles).slice(0, 5);
    const existingBlogPath = matches[0]?.path ?? null;

    try {
      await db.execute(sql`
        INSERT INTO agnb.content_gaps
          (topic, gap_score, competitor_count, our_coverage_count, suggested_keywords,
           representative_titles, suggestion_type, cluster_type, parent_topic,
           existing_blog_path, status, updated_at)
        VALUES (
          ${topic}, ${score}, ${agg.count}, ${ourCoverage}, ${suggestedKeywords}::text[],
          ${representativeTitles}::text[], ${suggestionType}, ${clusterType}, ${parentTopic},
          ${existingBlogPath}, 'identified', now()
        )
        ON CONFLICT (topic) DO UPDATE SET
          gap_score = EXCLUDED.gap_score,
          competitor_count = EXCLUDED.competitor_count,
          our_coverage_count = EXCLUDED.our_coverage_count,
          suggested_keywords = EXCLUDED.suggested_keywords,
          representative_titles = EXCLUDED.representative_titles,
          suggestion_type = EXCLUDED.suggestion_type,
          cluster_type = EXCLUDED.cluster_type,
          parent_topic = EXCLUDED.parent_topic,
          existing_blog_path = EXCLUDED.existing_blog_path,
          updated_at = now()
      `);
      gapsWritten++;
      if (suggestionType === "refresh") refreshCount++;
    } catch (e) {
      ctx.log("gap upsert error", { topic, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Phase C: enrich top-10 gaps with Google Suggest ─────────────────────
  const topGaps = rows<{ id: string; topic: string; suggested_keywords: string[] | null }>(
    await db.execute(sql`
      SELECT id, topic, suggested_keywords FROM agnb.content_gaps
      ORDER BY gap_score DESC
      LIMIT 10
    `),
  );
  let enriched = 0;
  for (const g of topGaps) {
    if (ctx.signal.aborted) break;
    try {
      const suggestions = await googleSuggest(String(g.topic).replace(/-/g, " "));
      if (suggestions.length === 0) continue;
      const existing = new Set((g.suggested_keywords ?? []) as string[]);
      for (const s of suggestions) existing.add(s);
      const merged = Array.from(existing).slice(0, 20);
      await db.execute(sql`
        UPDATE agnb.content_gaps SET suggested_keywords = ${merged}::text[], updated_at = now() WHERE id = ${g.id}
      `);
      enriched++;
      await new Promise((r) => setTimeout(r, 250));
    } catch {
      // best-effort
    }
  }

  ctx.log("gap-analyzer complete", { analyzed, gapsWritten, enriched });
  return {
    ok: true,
    processed: gapsWritten,
    phase_a: { analyzed, failed: analyzeFailed, pending_remaining: Math.max(0, pending.length - analyzed) },
    phase_b: { gaps_written: gapsWritten, refresh_suggestions: refreshCount, unique_topics: topicMap.size, finn_blog_count: finnBlogs.length },
    phase_c: { suggest_enriched: enriched },
    summary: `${analyzed} analyzed · ${gapsWritten} gaps · ${enriched} enriched`,
  };
}
