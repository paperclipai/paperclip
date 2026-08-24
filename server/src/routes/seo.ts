import { Router, type Request } from "express";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { companies, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * SEO routes: sitemap.xml and robots.txt.
 *
 * Both are registered at the top level (not under /api) and must be served
 * before the SPA fallback catch-all.
 */
export function seoRoutes(db: Db): Router {
  const router = Router({ caseSensitive: true });

  // ── robots.txt ─────────────────────────────────────────────────────
  // Dynamic host resolution: read X-Forwarded-Host when behind a proxy,
  // fall back to the Host header, then to a sensible default.
  router.get("/robots.txt", (_req: Request, res) => {
    const host = resolveRequestHost(_req);
    const sitemapUrl = `https://${host}/sitemap.xml`;

    res
      .status(200)
      .type("text/plain")
      .set("Cache-Control", "public, max-age=3600")
      .end(
        [
          "User-agent: *",
          "Allow: /",
          "Disallow: /api/",
          "",
          `Sitemap: ${sitemapUrl}`,
          "",
          "# robots.txt for Paperclip",
        ].join("\n"),
      );
  });

  // ── sitemap.xml ────────────────────────────────────────────────────
  // Query all public resources and generate XML. Returns an empty <urlset>
  // with 200 on DB error rather than 500 (crawlers retry 5xx, making a
  // transient DB hiccup into a spike of follow-up requests).
  router.get("/sitemap.xml", async (_req: Request, res) => {
    try {
      const host = resolveRequestHost(_req);

      // Gather active companies
      const activeCompanies = await db
        .select({
          id: companies.id,
          name: companies.name,
          issuePrefix: companies.issuePrefix,
          updatedAt: companies.updatedAt,
        })
        .from(companies)
        .where(eq(companies.status, "active"))
        .limit(10_000);

      // Gather public-facing issues (non-cancelled, non-backlog — content
      // customers may want indexed). Limits to 10 000 to avoid producing
      // a monster XML.
      const publicIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          companyId: issues.companyId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            ne(issues.status, "cancelled"),
            ne(issues.status, "backlog"),
            isNotNull(issues.identifier),
            isNull(issues.hiddenAt),
          ),
        )
        .limit(10_000);

      // Build a quick lookup from company id → issue prefix
      const companyPrefixMap = new Map<string, string>();
      for (const c of activeCompanies) {
        companyPrefixMap.set(c.id, c.issuePrefix);
      }

      const urls: string[] = [];

      // Static pages
      urls.push(formatUrl(host, "/", "2025-01-01"));
      urls.push(formatUrl(host, "/pricing", "2025-01-01"));

      // Company pages
      for (const c of activeCompanies) {
        urls.push(
          formatUrl(
            host,
            `/${c.issuePrefix}/dashboard`,
            toDateStr(c.updatedAt),
          ),
        );
        urls.push(
          formatUrl(
            host,
            `/${c.issuePrefix}/issues`,
            toDateStr(c.updatedAt),
          ),
        );
      }

      // Issue detail pages
      for (const issue of publicIssues) {
        const prefix = companyPrefixMap.get(issue.companyId);
        if (!prefix) continue; // skip orphaned rows
        urls.push(
          formatUrl(
            host,
            `/${prefix}/issues/${issue.identifier!}`,
            toDateStr(issue.updatedAt),
          ),
        );
      }

      const xml = buildSitemapXml(urls);
      res
        .status(200)
        .type("application/xml")
        .set("Cache-Control", "public, max-age=3600")
        .end(xml);
    } catch (err) {
      // DB failure → empty sitemap, not 500
      const xml = buildSitemapXml([]);
      res
        .status(200)
        .type("application/xml")
        .set("Cache-Control", "no-cache")
        .end(xml);
    }
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveRequestHost(req: Request): string {
  // X-Forwarded-Host can be a comma-separated list; take the first entry
  const forwarded = req.headers["x-forwarded-host"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(",")[0].trim();
  }
  return req.hostname || "paperclip.ai";
}

function toDateStr(date: Date | string | null | undefined): string {
  if (!date) return new Date().toISOString().split("T")[0];
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
  return d.toISOString().split("T")[0];
}

function formatUrl(host: string, path: string, lastmod: string): string {
  return [
    "  <url>",
    `    <loc>https://${escapeXml(host)}${escapeXml(path)}</loc>`,
    `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
    "    <changefreq>weekly</changefreq>",
    "  </url>",
  ].join("\n");
}

function buildSitemapXml(urls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
  ].join("\n");
}

/**
 * Escape XML special characters to prevent injection via X-Forwarded-Host
 * or other user-influenced values.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}