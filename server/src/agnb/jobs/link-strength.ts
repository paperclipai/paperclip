import { sql } from "drizzle-orm";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * link-strength — counts inbound internal links across the blog corpus to find
 * pillar posts (most linked-to) and orphans (0 inbound). Two sources:
 *   1. MDX files under content/blog/ (filesystem)
 *   2. published agnb.blog_drafts rows (mdx_body)
 *
 * Ported from agnb api/internal/link-strength. Bearer CRON_SECRET gate removed.
 * No external keys. Read-only analysis (the original never persisted results —
 * the agnb.blog_link_strength table does not exist in the schema).
 *
 * PARTIAL PORT: the content/blog/ filesystem source does not exist in the
 * Paperclip server's working directory, so that source no-ops gracefully and
 * the job effectively counts links from published blog_drafts only.
 *
 * Cadence: daily.
 */
export async function linkStrength(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, log } = ctx;

  // slug -> inbound count
  const linkCounts = new Map<string, number>();

  // Source 1: MDX files (absent on the server — guarded)
  try {
    const dir = join(process.cwd(), "content", "blog");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".mdx"));
    for (const f of files) {
      const txt = await readFile(join(dir, f), "utf8");
      const matches = txt.matchAll(/\[[^\]]+\]\(\/blog\/([a-z0-9-]+)/g);
      for (const m of matches) linkCounts.set(m[1], (linkCounts.get(m[1]) ?? 0) + 1);
    }
  } catch {
    /* no content/blog dir on server — skip */
  }

  // Source 2: published blog_drafts
  const drafts = rows<{ slug: string; mdx_body: string | null }>(
    await db.execute(sql`
      SELECT slug, mdx_body FROM agnb.blog_drafts WHERE status = 'published'
    `),
  );
  for (const d of drafts) {
    const matches = (d.mdx_body ?? "").matchAll(/\[[^\]]+\]\(\/blog\/([a-z0-9-]+)/g);
    for (const m of matches) linkCounts.set(m[1], (linkCounts.get(m[1]) ?? 0) + 1);
  }

  // All known slugs (fs + published drafts)
  let allSlugs: string[] = [];
  try {
    const dir = join(process.cwd(), "content", "blog");
    allSlugs = (await readdir(dir)).filter((f) => f.endsWith(".mdx")).map((f) => f.replace(/\.mdx$/, ""));
  } catch {
    /* skip */
  }
  for (const d of drafts) allSlugs.push(d.slug);

  const orphans = allSlugs.filter((s) => !linkCounts.has(s));
  const top = Array.from(linkCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const totalInbound = Array.from(linkCounts.values()).reduce((a, b) => a + b, 0);

  log("link strength done", { total_blogs: allSlugs.length, total_inbound: totalInbound, orphans: orphans.length });

  return {
    ok: true,
    total_blogs: allSlugs.length,
    total_inbound_links: totalInbound,
    most_linked: top.map(([slug, count]) => ({ slug, inbound_count: count })),
    orphans,
    orphan_count: orphans.length,
    summary: `${allSlugs.length} blogs, ${totalInbound} inbound links, ${orphans.length} orphans`,
  };
}
