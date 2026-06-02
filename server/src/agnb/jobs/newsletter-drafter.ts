import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import { generateJson, hasGeminiKey } from "../lib/gemini.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * newsletter-drafter — weekly. Collects last 7d published blog_drafts + the
 * latest daily_metrics_snapshots digest, Gemini writes a subject + 2-paragraph
 * intro, stores a draft in agnb.newsletter_issues. Ported from
 * agnb api/internal/newsletter-drafter.
 */

interface Blog { id: string; title: string; slug: string; description: string | null; }

async function geminiNewsletter(
  blogs: Blog[],
  digestText: string | null,
  signal: AbortSignal,
): Promise<{ subject: string; intro: string; inTok: number; outTok: number }> {
  const prompt = `Write a weekly newsletter for Finn (B2B AI voice agent platform).

THIS WEEK'S PUBLISHED BLOGS:
${blogs.map((b) => `- "${b.title}" — ${b.description ?? ""} (/blog/${b.slug})`).join("\n")}

OPS DIGEST (today's anomalies):
${digestText ?? "(no anomalies this week)"}

Write:
1. Subject line (<= 60 chars, no emojis, no exclamation marks, mention the top blog topic)
2. 2-paragraph intro (~120 words) — what's most relevant for B2B ops/CX leaders this week, lead with the strongest blog's insight

Return JSON only:
{
  "subject": "<subject line>",
  "intro": "<plain-text 2-paragraph intro>"
}`;
  try {
    const { data, inTok, outTok } = await generateJson<{ subject?: string; intro?: string }>(prompt, {
      temperature: 0.6,
      maxOutputTokens: 1200,
      timeoutMs: 20_000,
      signal,
    });
    return { subject: data.subject ?? "", intro: data.intro ?? "", inTok, outTok };
  } catch {
    return { subject: "", intro: "", inTok: 0, outTok: 0 };
  }
}

export async function newsletterDrafter(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  if (!hasGeminiKey()) return { ok: true, summary: "skipped: no GEMINI_API_KEY" };

  const periodStart = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const periodEnd = new Date().toISOString().slice(0, 10);

  const blogs = rows<Blog>(
    await db.execute(sql`
      SELECT id, title, slug, description
      FROM agnb.blog_drafts
      WHERE status = 'published' AND published_at >= ${periodStart}
      ORDER BY published_at DESC
      LIMIT 10
    `),
  );

  if (blogs.length === 0) {
    return { ok: true, drafted: false, summary: "no blogs published this week" };
  }

  const digest = rows<{ digest_text: string | null }>(
    await db.execute(sql`
      SELECT digest_text FROM agnb.daily_metrics_snapshots
      ORDER BY snapshot_date DESC
      LIMIT 1
    `),
  )[0];

  const gen = await geminiNewsletter(blogs, digest?.digest_text ?? null, ctx.signal);
  if (!gen.subject || !gen.intro) return { ok: false, summary: "gemini empty" };

  const bodyHtml = `
<p>${gen.intro.replace(/\n\n/g, "</p><p>")}</p>
<h2>This week's reads</h2>
<ul>
${blogs.map((b) => `<li><a href="https://hirefinn.ai/blog/${b.slug}"><strong>${b.title}</strong></a><br/>${b.description ?? ""}</li>`).join("\n")}
</ul>
<p>— Finn team</p>
<p style="font-size:11px;opacity:0.6">Reply if you want us to write about a specific topic next week.</p>`;

  const issueNumber = (rows<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM agnb.newsletter_issues`),
  )[0]?.n ?? 0) + 1;

  // pg uuid[] literal: '{uuid1,uuid2}' (matches the convention in groups/renewals.ts).
  const blogIdsLiteral = `{${blogs.map((b) => b.id).join(",")}}`;
  const inserted = rows<{ id: string }>(
    await db.execute(sql`
      INSERT INTO agnb.newsletter_issues
        (issue_number, period_start, period_end, subject, intro, blog_ids, body_html, status)
      VALUES (
        ${issueNumber}, ${periodStart}, ${periodEnd}, ${gen.subject}, ${gen.intro},
        ${blogIdsLiteral}::uuid[], ${bodyHtml}, 'draft'
      )
      RETURNING id
    `),
  )[0];

  ctx.log("newsletter drafted", { issue_number: issueNumber, draft_id: inserted?.id, blog_count: blogs.length });
  return {
    ok: true,
    drafted: true,
    issue_number: issueNumber,
    draft_id: inserted?.id,
    blog_count: blogs.length,
    summary: `issue #${issueNumber}, ${blogs.length} blogs`,
  };
}
