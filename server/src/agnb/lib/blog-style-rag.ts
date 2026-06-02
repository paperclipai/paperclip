import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { rows } from "../helpers.js";

/**
 * Style-reference RAG for the blog drafter — ported from
 * agnb lib/agnb/blog-style-rag.ts.
 *
 * loadStyleExamples / findRelatedBlogSlugs / loadStyleGuide read the original
 * Next.js repo's content/blog/*.mdx tree off disk. In the Paperclip server
 * that tree is absent, so they degrade gracefully (return [] / "") — the
 * drafter still runs, just without few-shot voice examples. loadFinnStats was
 * migrated from supabase to drizzle (agnb.* tables).
 */

export interface BlogExample {
  title: string;
  description: string;
  excerpt: string; // first ~600 chars stripped of frontmatter
}

const BLOG_DIR = join(process.cwd(), "content", "blog");

/** Load operator-managed style guide markdown if present on disk. */
export async function loadStyleGuide(): Promise<string> {
  try {
    return await readFile(join(BLOG_DIR, "_style-guide.md"), "utf8");
  } catch {
    return "";
  }
}

/** Pull N random existing blog posts off disk as few-shot examples. */
export async function loadStyleExamples(n = 2): Promise<BlogExample[]> {
  try {
    const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith(".mdx") && !f.startsWith("_"));
    if (files.length === 0) return [];
    const shuffled = files.sort(() => Math.random() - 0.5).slice(0, n);
    const out: BlogExample[] = [];
    for (const f of shuffled) {
      const raw = await readFile(join(BLOG_DIR, f), "utf8");
      const title = raw.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";
      const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";
      const body = raw.replace(/^---[\s\S]*?---\s*/m, "").trim();
      out.push({ title, description, excerpt: body.slice(0, 600).trim() });
    }
    return out;
  } catch {
    return [];
  }
}

/** Pull live ops stats from the AGNB DB so drafts can use real numbers. */
export async function loadFinnStats(db: Db): Promise<Record<string, string>> {
  try {
    const [assets, customers, drafts, competitors] = await Promise.all([
      db.execute(sql`SELECT count(*)::int AS n FROM agnb.marketing_assets`),
      db.execute(sql`SELECT count(DISTINCT customer_name)::int AS n FROM agnb.filled_assets WHERE customer_name IS NOT NULL`),
      db.execute(sql`SELECT count(*)::int AS n FROM agnb.blog_drafts WHERE status = 'published'`),
      db.execute(sql`SELECT count(*)::int AS n FROM agnb.competitors`),
    ]);
    const one = (r: unknown) => rows<{ n: number }>(r)[0]?.n ?? 0;
    return {
      marketing_assets_count: String(one(assets)),
      unique_customers: String(one(customers)),
      published_blogs: String(one(drafts)),
      competitors_tracked: String(one(competitors)),
    };
  } catch {
    return {};
  }
}

/** Find existing Finn blog slugs (off disk) whose title contains any keyword. */
export async function findRelatedBlogSlugs(keywords: string[], limit = 5): Promise<Array<{ slug: string; title: string }>> {
  try {
    const files = (await readdir(BLOG_DIR)).filter((f) => f.endsWith(".mdx"));
    const matches: Array<{ slug: string; title: string; score: number }> = [];
    const kwLower = keywords.map((k) => k.toLowerCase());
    for (const f of files) {
      const raw = await readFile(join(BLOG_DIR, f), "utf8");
      const title = raw.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";
      const slug = f.replace(/\.mdx$/, "");
      const titleLower = title.toLowerCase();
      let score = 0;
      for (const kw of kwLower) if (titleLower.includes(kw)) score++;
      if (score > 0) matches.push({ slug, title, score });
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit).map(({ slug, title }) => ({ slug, title }));
  } catch {
    return [];
  }
}
