import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { generate, hasGeminiKey } from "../lib/gemini.js";
import { nextSlot, type ScheduleSettings } from "../lib/blog-scheduler.js";
import { loadStyleExamples, loadFinnStats, findRelatedBlogSlugs, loadStyleGuide } from "../lib/blog-style-rag.js";
import { loadCustomerQuotes } from "../lib/customer-quotes.js";
import { scoreBlogDraft } from "../lib/seo-score.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * blog-auto-drafter — multi-pass drafter, ported from
 * agnb api/internal/blog-auto-drafter.
 *
 *   Pass 1   Outline
 *   Pass 1.5 Outline critique + revision
 *   Pass 2   Body draft (style RAG + Finn stats + customer quotes)
 *   Pass 3   SEO polish (internal links + FAQ + JSON-LD)
 *   Pass 4   Fact-check
 *   Pass 5   Plagiarism check vs competitor titles
 *   Pass 6   Multi-title generation + auto-pick by SEO score
 *
 * Pillars (cluster_type='pillar') are never auto-scheduled — operator review.
 *
 * PARTIAL PORT: the optional Pass 3.5 SERP-gap analysis + community-question +
 * Unsplash-hero enrichments are omitted because they depend on serp-analysis,
 * community-research and unsplash-hero libs that are out of this port's scope.
 * Those were best-effort try/catch passes in the original — their absence does
 * not change the core draft output, only the frontmatter enrichment fields
 * (image*, community_questions, serp_gaps are left null/empty).
 */

const MAX_DRAFTS_PER_RUN = 3;
const MIN_GAP_SCORE = 25;

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function inferPersona(topic: string, keywords: string[]): string {
  const all = [topic, ...keywords].join(" ").toLowerCase();
  if (/cfo|cost|roi|tco|budget|pricing|saving/.test(all)) return "CFO / finance leader";
  if (/cto|architect|engineer|api|sdk|latency|infrastructure/.test(all)) return "CTO / engineering lead";
  if (/cmo|brand|seo|outbound|marketing|campaign/.test(all)) return "CMO / growth marketer";
  if (/ops|workflow|automation|process|playbook/.test(all)) return "operations / RevOps manager";
  if (/csm|customer success|nps|retention|churn/.test(all)) return "Customer Success leader";
  return "B2B operations leader";
}

export async function blogAutoDrafter(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, signal } = ctx;
  if (!hasGeminiKey()) return { ok: true, summary: "skipped: no GEMINI_API_KEY" };

  let usageIn = 0, usageOut = 0;
  const trackUsage = (i: number, o: number) => { usageIn += i; usageOut += o; };

  /** Local Gemini JSON call mirroring the original drafter's geminiCall (text → strip → parse). */
  async function geminiCall(prompt: string, maxOutputTokens: number, temperature: number): Promise<string> {
    const { text, inTok, outTok } = await generate(prompt, {
      temperature,
      maxOutputTokens,
      timeoutMs: 60_000,
      signal,
      jsonSchema: undefined,
    });
    trackUsage(inTok, outTok);
    return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }

  // ── Outline ──────────────────────────────────────────────────────────────
  interface OutlineResp { hook: string; sections: { h2: string; bullets: string[] }[]; conclusion: string; unique_angle: string; }
  interface DraftResp { title: string; slug: string; description: string; keywords: string[]; categories: string[]; mdx_body: string; }
  interface SeoResp { mdx_body: string; faq_jsonld: string; injected_links: string[]; }
  interface FactCheckResp { flagged_claims: Array<{ claim: string; severity: "low" | "med" | "high"; reason: string }>; overall_confidence: number; }

  async function passOutline(args: { topic: string; keywords: string[]; competitorTitles: string[]; stats: Record<string, string>; clusterType: string; targetWords: number; persona: string; styleGuide: string }): Promise<OutlineResp> {
    const clusterHint = args.clusterType === "pillar"
      ? "This is a PILLAR post — broad, comprehensive overview. Aim for 5-7 H2 sections covering the topic exhaustively. First section is a 'Table of Contents'. Will be referenced + linked to by spoke posts."
      : args.clusterType === "spoke"
      ? "This is a SPOKE post — narrow deep-dive on one specific aspect. 3-4 tight H2 sections."
      : "Standalone post — 3-5 sections, self-contained.";
    const styleGuideBlock = args.styleGuide ? `\nSTYLE GUIDE (follow strictly):\n${args.styleGuide}\n` : "";
    const prompt = `You are planning a blog post for Finn (B2B AI voice agents, India + US/EU).
${styleGuideBlock}

TOPIC: ${args.topic}
TARGET PERSONA: ${args.persona}
CLUSTER TYPE: ${args.clusterType} — ${clusterHint}
TARGET LENGTH: ~${args.targetWords} words
TARGET KEYWORDS: ${args.keywords.slice(0, 6).join(", ")}

COMPETITORS COVERING THIS (do NOT copy their angles):
${args.competitorTitles.slice(0, 5).map((t) => `- ${t}`).join("\n")}

LIVE FINN DATA YOU CAN REFERENCE:
${Object.entries(args.stats).map(([k, v]) => `- ${k}: ${v}`).join("\n")}

Plan a ${args.targetWords}-word post with a UNIQUE ANGLE that competitors haven't taken. Lean on technical depth, India market lens, or contrarian-but-true takes that match the persona.

Return JSON only:
{
  "unique_angle": "1-sentence: how this post differs from competitor coverage",
  "hook": "1-2 sentence opening, concrete, no fluff, persona-tuned",
  "sections": [
    { "h2": "section heading", "bullets": ["3-5 bullets the section will cover"] }
  ],
  "conclusion": "1-2 sentence forward-looking close (no CTA, no 'Are you ready')"
}`;
    return JSON.parse(await geminiCall(prompt, 2000, 0.5));
  }

  async function passOutlineCritique(args: { topic: string; outline: OutlineResp }): Promise<OutlineResp> {
    const prompt = `Review this blog outline. Critique then revise.

TOPIC: ${args.topic}
CURRENT OUTLINE:
- Unique angle: ${args.outline.unique_angle}
- Hook: ${args.outline.hook}
${args.outline.sections.map((s, i) => `- H2 ${i + 1}: ${s.h2}\n  ${s.bullets.map((b) => `· ${b}`).join("\n  ")}`).join("\n")}
- Conclusion: ${args.outline.conclusion}

CRITIQUE THEN REVISE in JSON form. Critique privately, return ONLY the revised outline. Focus on:
1. Is the unique_angle truly unique vs typical posts? Sharpen if generic.
2. Does the hook earn the reader's next 10 seconds? Rewrite if it's bland.
3. Are sections logically ordered (broad → narrow OR problem → solution → action)?
4. Are any sections redundant or overlapping? Merge them.
5. Are any obvious questions a reader would have unanswered? Add a section.
6. Bullets — are they specific enough? Avoid "Best practices for X" type fluff.

Return same JSON shape as outline (unique_angle, hook, sections, conclusion) — REVISED.`;
    return JSON.parse(await geminiCall(prompt, 2000, 0.4));
  }

  async function passDraft(args: { topic: string; outline: OutlineResp; keywords: string[]; styleExamples: Array<{ title: string; description: string; excerpt: string }>; stats: Record<string, string>; clusterType: string; targetWords: number; parentPillarLink: { slug: string; title: string } | null; persona: string; customerQuotes: Array<{ customer: string; quote: string }>; styleGuide: string }): Promise<DraftResp> {
    const examples = args.styleExamples.map((e, i) =>
      `Example ${i + 1} — title: ${e.title}\ndescription: ${e.description}\nexcerpt:\n${e.excerpt}`,
    ).join("\n\n---\n\n");
    const quotesBlock = args.customerQuotes.length > 0
      ? `\nREAL FINN CUSTOMER CONTEXT (anonymized — use sparingly to ground claims):\n${args.customerQuotes.map((q) => `- ${q.customer ? "[" + q.customer + "]" : "(anon)"} ${q.quote.slice(0, 200)}`).join("\n")}\n`
      : "";
    const styleGuideBlock = args.styleGuide ? `\nSTYLE GUIDE (override examples on conflict):\n${args.styleGuide}\n` : "";
    const prompt = `You are writing a blog post for Finn. Match the VOICE + STRUCTURE of the example posts below exactly — same sentence rhythm, paragraph density, use of lists, technical specificity.
${styleGuideBlock}

VOICE EXAMPLES FROM FINN'S EXISTING BLOG:
${examples}

YOUR TASK
Topic: ${args.topic}
Target persona: ${args.persona}
Unique angle: ${args.outline.unique_angle}
Target keywords: ${args.keywords.slice(0, 6).join(", ")}

OUTLINE (follow exactly):
Hook: ${args.outline.hook}
Sections:
${args.outline.sections.map((s) => `## ${s.h2}\n${s.bullets.map((b) => `- ${b}`).join("\n")}`).join("\n\n")}
Conclusion: ${args.outline.conclusion}

DATA YOU CAN CITE (use selectively, only when relevant):
${Object.entries(args.stats).map(([k, v]) => `- ${k}: ${v}`).join("\n")}
${quotesBlock}

REQUIREMENTS
- ~${args.targetWords} words total
- Start with the hook (no H1 — title is separate)
- Use ## for sections, ### sparingly for sub-sections
- 2-4 sentence paragraphs, mix with bullet lists where natural
- Concrete examples + numbers > abstract claims
- One <Callout type="info"> block in the middle if useful
- If a technical concept benefits from a process flow, include ONE Mermaid diagram in a \`\`\`mermaid code block
- For engineering-tagged content, include 1-2 actual code snippets showing real configs/commands
- If a section would benefit from a video walkthrough, leave a stub: "{/* VIDEO_STUB: 90-sec explainer of X */}"
- End with the conclusion. No CTA. No "Contact us today."
- Use target keywords 2-3 times naturally, never stuff
${args.parentPillarLink ? `- This is a SPOKE post — reference the parent pillar early via this internal link: [${args.parentPillarLink.title}](/blog/${args.parentPillarLink.slug})` : ""}
${args.clusterType === "pillar" ? `- This is a PILLAR post — open with a markdown table-of-contents listing the H2 sections so readers can navigate. Be comprehensive.` : ""}

Return JSON only:
{
  "title": "<= 70 chars, no clickbait",
  "slug": "url-safe-kebab",
  "description": "140-160 chars meta description, ends with period",
  "keywords": ["5-8 SEO keywords"],
  "categories": ["1-2 of: ops, ai, voice-ai, outbound, inbound, customer-success, engineering"],
  "mdx_body": "full body MDX, no frontmatter, no H1"
}`;
    return JSON.parse(await geminiCall(prompt, 8000, 0.65));
  }

  async function passSeo(args: { draft: DraftResp; relatedBlogs: Array<{ slug: string; title: string }> }): Promise<SeoResp> {
    if (args.relatedBlogs.length === 0) {
      return { mdx_body: args.draft.mdx_body, faq_jsonld: "", injected_links: [] };
    }
    const internalLinks = args.relatedBlogs.map((b) => `- [${b.title}](/blog/${b.slug})`).join("\n");
    const prompt = `Polish this blog post for SEO:

1) Inject 2-3 internal links to related Finn posts (from list below) into the body where they naturally fit. Use markdown link syntax. Descriptive anchor text (no "click here").
2) Add "## Frequently Asked Questions" section before the conclusion with 3 Q&A pairs derived from the post.
3) Generate matching FAQ JSON-LD schema as a string.

RELATED FINN POSTS:
${internalLinks}

ORIGINAL POST TITLE: ${args.draft.title}
ORIGINAL DESCRIPTION: ${args.draft.description}
ORIGINAL BODY:
${args.draft.mdx_body}

Return JSON only:
{
  "mdx_body": "<polished body with internal links + FAQ injected>",
  "faq_jsonld": "<JSON-LD as escaped string>",
  "injected_links": ["<slug>", "<slug>"]
}`;
    return JSON.parse(await geminiCall(prompt, 8000, 0.4));
  }

  async function passFactCheck(args: { mdxBody: string }): Promise<FactCheckResp> {
    const prompt = `You are fact-checking a Finn blog post. Identify claims that lack sufficient evidence in the post itself or are likely wrong.

BLOG BODY:
${args.mdxBody.slice(0, 6000)}

For each questionable claim, flag with severity:
- "high"  — likely false / contradicts well-known facts / fabricated stats
- "med"   — plausible but unsupported (no source, no method, no Finn data)
- "low"   — minor exaggeration

Return JSON only:
{
  "flagged_claims": [
    { "claim": "<quoted text from post>", "severity": "high|med|low", "reason": "<why>" }
  ],
  "overall_confidence": 0-100
}`;
    return JSON.parse(await geminiCall(prompt, 3000, 0.2));
  }

  async function passPlagiarismCheck(args: { draft: DraftResp; competitorTitles: string[] }): Promise<{ overlap_score: number; flagged_overlaps: string[] }> {
    if (args.competitorTitles.length === 0) return { overlap_score: 0, flagged_overlaps: [] };
    const prompt = `Compare this blog post's structure + angles to competitor titles on the same topic.

COMPETITOR TITLES:
${args.competitorTitles.slice(0, 10).map((t) => `- ${t}`).join("\n")}

OUR POST TITLE: ${args.draft.title}
OUR POST DESCRIPTION: ${args.draft.description}
OUR POST FIRST 1000 CHARS:
${args.draft.mdx_body.slice(0, 1000)}

Return JSON only:
{
  "overlap_score": 0-100 (how much our angle/structure overlaps with competitors),
  "flagged_overlaps": ["<phrase or angle that closely mirrors a competitor>"]
}

A score >50 means too derivative — operator should revise.`;
    return JSON.parse(await geminiCall(prompt, 1000, 0.3));
  }

  async function passMultiTitle(args: { topic: string; draft: DraftResp; persona: string; primaryKeyword: string }): Promise<string[]> {
    const prompt = `Generate 5 alternative titles for this blog. Each must be <= 70 chars, specific (not generic), include the primary keyword naturally where possible, and match the persona.

TOPIC: ${args.topic}
PERSONA: ${args.persona}
PRIMARY KEYWORD: ${args.primaryKeyword}
CURRENT TITLE: ${args.draft.title}
DESCRIPTION: ${args.draft.description}

Return JSON array of 5 strings only:
["title 1", "title 2", "title 3", "title 4", "title 5"]`;
    const parsed = JSON.parse(await geminiCall(prompt, 600, 0.8));
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  }

  // ── Pull qualifying gaps ───────────────────────────────────────────────────
  const gaps = rows<{
    id: string;
    topic: string;
    gap_score: number;
    suggested_keywords: string[] | null;
    representative_titles: string[] | null;
    suggestion_type: string;
    cluster_type: string | null;
    parent_topic: string | null;
  }>(
    await db.execute(sql`
      SELECT id, topic, gap_score, suggested_keywords, representative_titles,
             suggestion_type, cluster_type, parent_topic
      FROM agnb.content_gaps
      WHERE status = 'identified' AND suggestion_type = 'new' AND gap_score >= ${MIN_GAP_SCORE}
      ORDER BY gap_score DESC
      LIMIT ${MAX_DRAFTS_PER_RUN}
    `),
  );

  if (gaps.length === 0) return { ok: true, drafted: 0, summary: "no qualifying gaps" };

  // ── Auto-schedule settings ─────────────────────────────────────────────────
  const settingsRow = rows<ScheduleSettings>(
    await db.execute(sql`
      SELECT cadence_days, preferred_dow, preferred_hour, timezone, enabled
      FROM agnb.blog_schedule_settings WHERE id = 1
    `),
  )[0];
  const autoSchedule = settingsRow?.enabled === true ? settingsRow : null;

  let lastScheduledAt: string | null = null;
  if (autoSchedule) {
    lastScheduledAt = rows<{ scheduled_at: string | null }>(
      await db.execute(sql`
        SELECT scheduled_at FROM agnb.blog_drafts
        WHERE scheduled_at IS NOT NULL
        ORDER BY scheduled_at DESC LIMIT 1
      `),
    )[0]?.scheduled_at ?? null;
  }

  const [styleExamples, stats, styleGuide] = await Promise.all([
    loadStyleExamples(2),
    loadFinnStats(db),
    loadStyleGuide(),
  ]);

  const results: Array<Record<string, unknown>> = [];

  for (const gap of gaps) {
    if (signal.aborted) break;
    const startedAt = Date.now();
    try {
      const keywords = gap.suggested_keywords ?? [];
      const competitorTitles = gap.representative_titles ?? [];
      const clusterType = gap.cluster_type ?? "standalone";
      const targetWords = clusterType === "pillar" ? 2500 : clusterType === "spoke" ? 800 : 900;
      const persona = inferPersona(gap.topic, keywords);

      let parentPillarLink: { slug: string; title: string } | null = null;
      if (clusterType === "spoke" && gap.parent_topic) {
        const parent = rows<{ slug: string; title: string }>(
          await db.execute(sql`
            SELECT slug, title FROM agnb.blog_drafts
            WHERE status = 'published' AND title ILIKE ${"%" + gap.parent_topic.replace(/-/g, " ") + "%"}
            LIMIT 1
          `),
        )[0];
        if (parent) parentPillarLink = parent;
      }

      const customerQuotes = await loadCustomerQuotes(db, gap.topic, 2);

      let outline = await passOutline({ topic: gap.topic, keywords, competitorTitles, stats, clusterType, targetWords, persona, styleGuide });
      try { outline = await passOutlineCritique({ topic: gap.topic, outline }); } catch { /* keep original */ }

      const draft = await passDraft({ topic: gap.topic, outline, keywords, styleExamples, stats, clusterType, targetWords, parentPillarLink, persona, customerQuotes, styleGuide });

      const relatedBlogs = await findRelatedBlogSlugs(keywords, 5);
      const seo = await passSeo({ draft, relatedBlogs });

      let factCheck: FactCheckResp = { flagged_claims: [], overall_confidence: 70 };
      try { factCheck = await passFactCheck({ mdxBody: seo.mdx_body }); } catch { /* skip */ }

      let plagiarism: { overlap_score: number; flagged_overlaps: string[] } = { overlap_score: 0, flagged_overlaps: [] };
      try { plagiarism = await passPlagiarismCheck({ draft: { ...draft, mdx_body: seo.mdx_body }, competitorTitles }); } catch { /* skip */ }

      let finalTitle = draft.title;
      let titleCandidates: string[] = [draft.title];
      try {
        const alts = await passMultiTitle({ topic: gap.topic, draft, persona, primaryKeyword: keywords[0] ?? gap.topic });
        titleCandidates = [draft.title, ...alts];
        const scored = titleCandidates.map((t) => ({
          title: t,
          score: scoreBlogDraft({ title: t, description: draft.description, body: seo.mdx_body, keywords }).overall,
        }));
        scored.sort((a, b) => b.score - a.score);
        finalTitle = scored[0]?.title ?? draft.title;
      } catch { /* keep original */ }

      const operatorNotes: string[] = [];
      if (factCheck.flagged_claims.length > 0) {
        operatorNotes.push(`<!-- FACT-CHECK FLAGS (confidence ${factCheck.overall_confidence}/100):\n${factCheck.flagged_claims.map((c) => `- [${c.severity}] "${c.claim.slice(0, 100)}" — ${c.reason}`).join("\n")}\n-->`);
      }
      if (plagiarism.overlap_score > 50) {
        operatorNotes.push(`<!-- PLAGIARISM WARNING (${plagiarism.overlap_score}% overlap): ${plagiarism.flagged_overlaps.join(" · ")} -->`);
      }
      const finalBody = [
        operatorNotes.join("\n\n"),
        seo.mdx_body,
        seo.faq_jsonld ? `\n\n{/* SEO: FAQ schema */}\n<script type="application/ld+json">{${JSON.stringify(seo.faq_jsonld)}}</script>` : "",
      ].filter(Boolean).join("\n\n");

      let slug = draft.slug || slugify(finalTitle);
      const existing = rows<{ id: string }>(
        await db.execute(sql`SELECT id FROM agnb.blog_drafts WHERE slug = ${slug} LIMIT 1`),
      )[0];
      if (existing) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;

      let scheduledAt: string | null = null;
      let draftStatus = "draft";
      const allowAutoSchedule = autoSchedule && clusterType !== "pillar";
      if (allowAutoSchedule) {
        scheduledAt = nextSlot(autoSchedule, lastScheduledAt);
        lastScheduledAt = scheduledAt;
        draftStatus = "scheduled";
      }

      const defaultAuthor = rows<{ slug: string }>(
        await db.execute(sql`
          SELECT slug FROM agnb.blog_authors
          WHERE is_active = true ORDER BY created_at ASC LIMIT 1
        `),
      )[0];

      const frontmatter = {
        published: true,
        keywords: draft.keywords ?? [],
        categories: draft.categories ?? [],
        related: seo.injected_links ?? [],
        cluster_type: clusterType,
        parent_topic: gap.parent_topic ?? null,
        target_persona: persona,
        title_candidates: titleCandidates,
        fact_check: { confidence: factCheck.overall_confidence, flag_count: factCheck.flagged_claims.length },
        plagiarism_score: plagiarism.overlap_score,
        // Enrichment fields (hero image / community Qs / SERP gaps) omitted in this port.
        image: null,
        image_alt: null,
        image_source: null,
        image_attribution: null,
        community_questions: [],
        serp_gaps: null,
      };

      const blogDraft = rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO agnb.blog_drafts
            (title, slug, description, mdx_body, author_slug, frontmatter, status,
             scheduled_at, cluster_type, target_word_count, parent_topic, created_by)
          VALUES (
            ${finalTitle}, ${slug}, ${draft.description}, ${finalBody},
            ${defaultAuthor?.slug ?? "finn-team"}, ${JSON.stringify(frontmatter)}::jsonb, ${draftStatus},
            ${scheduledAt}, ${clusterType}, ${targetWords}, ${gap.parent_topic ?? null}, 'auto-drafter-v3'
          )
          RETURNING id
        `),
      )[0];

      await db.execute(sql`
        UPDATE agnb.content_gaps
        SET status = 'drafted', auto_drafted_at = now(),
            auto_drafted_blog_id = ${blogDraft.id}, updated_at = now()
        WHERE id = ${gap.id}
      `);

      results.push({
        topic: gap.topic, ok: true, blog_draft_id: blogDraft.id, title: finalTitle,
        cluster_type: clusterType, persona, unique_angle: outline.unique_angle,
        title_candidates: titleCandidates.length,
        fact_check_flags: factCheck.flagged_claims.length, plagiarism_score: plagiarism.overlap_score,
        internal_links: seo.injected_links.length, customer_quotes: customerQuotes.length,
        forced_review: clusterType === "pillar", elapsed_ms: Date.now() - startedAt,
      });
      ctx.log("blog drafted", { topic: gap.topic, blog_draft_id: blogDraft.id, title: finalTitle });
    } catch (e) {
      results.push({ topic: gap.topic, ok: false, error: e instanceof Error ? e.message : String(e), elapsed_ms: Date.now() - startedAt });
      ctx.log("blog draft error", { topic: gap.topic, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const drafted = results.filter((r) => r.ok).length;
  return {
    ok: true,
    drafted,
    processed: drafted,
    style_examples_used: styleExamples.length,
    stats_pulled: Object.keys(stats).length,
    results,
    _usage: { inputTokens: usageIn, outputTokens: usageOut },
    summary: `${drafted}/${gaps.length} drafted`,
  };
}
