import { sql } from "drizzle-orm";
import { fetchSitemapEntries, filterBlogUrls, scrapeBlogPage, sleep } from "../lib/sitemap-scraper.js";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * sitemap-scraper — iterates active competitors, fetches sitemap.xml for each,
 * filters blog URLs, scrapes new ones (not already in agnb.competitor_blogs),
 * stores them. Rate-limited 1 req/sec per host. Each competitor capped at
 * MAX_NEW_PER_RUN to keep runtime predictable.
 *
 * Ported from agnb api/internal/sitemap-scraper. Bearer CRON_SECRET gate
 * removed. No external keys required — pure crawl. Cadence: daily.
 */
const MAX_NEW_PER_RUN = 25; // per competitor
const MAX_COMPETITORS_PER_RUN = 10;

interface CompetitorRow {
  id: string;
  name: string;
  domain: string;
  sitemap_url: string;
  blog_path_pattern: string | null;
  last_scraped_at: string | null;
}

export async function sitemapScraper(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db, log } = ctx;

  const competitors = rows<CompetitorRow>(
    await db.execute(sql`
      SELECT id, name, domain, sitemap_url, blog_path_pattern, last_scraped_at
      FROM agnb.competitors
      WHERE status = 'active'
      ORDER BY last_scraped_at ASC NULLS FIRST
      LIMIT ${MAX_COMPETITORS_PER_RUN}
    `),
  );

  if (competitors.length === 0) return { ok: true, processed: 0, summary: "no active competitors" };

  const results: Array<Record<string, unknown>> = [];

  for (const c of competitors) {
    if (ctx.signal.aborted) break;
    const startedAt = Date.now();
    try {
      const entries = await fetchSitemapEntries(c.sitemap_url);
      if (entries.length === 0) {
        await db.execute(sql`
          UPDATE agnb.competitors
          SET last_scraped_at = now(),
              last_error = 'sitemap returned 0 entries (blocked? wrong URL?)',
              updated_at = now()
          WHERE id = ${c.id}
        `);
        results.push({ competitor: c.name, status: "empty_sitemap", elapsed_ms: Date.now() - startedAt });
        continue;
      }

      const blogs = filterBlogUrls(entries, c.blog_path_pattern ?? "/blog/");

      // De-dup: skip URLs already in DB
      const urlList = blogs.map((b) => b.url);
      const existingSet = new Set<string>();
      if (urlList.length > 0) {
        const existing = rows<{ url: string }>(
          await db.execute(sql`
            SELECT url FROM agnb.competitor_blogs
            WHERE url = ANY(${urlList})
          `),
        );
        for (const e of existing) existingSet.add(e.url);
      }
      const toScrape = blogs.filter((b) => !existingSet.has(b.url)).slice(0, MAX_NEW_PER_RUN);

      let inserted = 0;
      let failed = 0;
      for (const b of toScrape) {
        if (ctx.signal.aborted) break;
        try {
          const scraped = await scrapeBlogPage(b.url);
          const publishedAt = scraped.published_at ?? b.lastmod ?? null;
          const res = await db.execute(sql`
            INSERT INTO agnb.competitor_blogs
              (competitor_id, url, title, description, content_excerpt, published_at, analysis_status)
            VALUES
              (${c.id}, ${scraped.url}, ${scraped.title}, ${scraped.description}, ${scraped.excerpt}, ${publishedAt}, 'pending')
            ON CONFLICT DO NOTHING
          `);
          if (((res as { rowCount?: number })?.rowCount ?? 0) > 0) inserted++;
          else failed++;
        } catch {
          failed++;
        }
        await sleep(1_000); // 1 req/sec polite throttle
      }

      await db.execute(sql`
        UPDATE agnb.competitors
        SET last_scraped_at = now(),
            last_error = NULL,
            total_blogs_seen = ${blogs.length},
            updated_at = now()
        WHERE id = ${c.id}
      `);

      results.push({
        competitor: c.name,
        sitemap_total: entries.length,
        blog_matches: blogs.length,
        new_scraped: inserted,
        failed,
        elapsed_ms: Date.now() - startedAt,
      });
      log("competitor scraped", { competitor: c.name, blog_matches: blogs.length, new_scraped: inserted });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.execute(sql`
        UPDATE agnb.competitors
        SET last_scraped_at = now(), last_error = ${msg}, updated_at = now()
        WHERE id = ${c.id}
      `);
      results.push({ competitor: c.name, status: "error", error: msg, elapsed_ms: Date.now() - startedAt });
      log("competitor scrape error", { competitor: c.name, error: msg });
    }
  }

  return { ok: true, processed: results.length, results, summary: `${results.length} competitors` };
}
