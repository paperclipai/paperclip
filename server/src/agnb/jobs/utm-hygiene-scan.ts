import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * utm-hygiene-scan — daily scan of marketing assets + blog drafts. Ported
 * from agnb api/internal/utm-hygiene-scan. For every outbound hirefinn.ai
 * URL found in HTML / MDX body, flags missing_utm / malformed, plus
 * inconsistent_campaign across assets. Upserts agnb.utm_hygiene_issues and
 * auto-resolves stale issues. No external deps — always runs.
 */
const KNOWN_OUR_DOMAIN_REGEX = /(?:^|\/\/)(?:www\.)?hirefinn\.ai\b/i;

type Issue = {
  source_kind: string;
  source_id: string;
  source_name: string;
  url: string;
  issue_type: string;
  severity: string;
  details: string;
};

function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"')]+/g;
  return Array.from(text.matchAll(re)).map((m) => m[0].replace(/[),.!?]+$/, ""));
}

function checkUrl(url: string): { issue_type: string; severity: string; details: string } | null {
  if (!KNOWN_OUR_DOMAIN_REGEX.test(url)) return null;
  if (url.includes("#") && !url.includes("?")) return null;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("utm_source")) {
      return { issue_type: "missing_utm", severity: "warn", details: "no utm_source param" };
    }
    for (const [k, v] of u.searchParams) {
      if (k.toLowerCase().startsWith("utm_") && !v.trim()) {
        return { issue_type: "malformed", severity: "warn", details: `${k} has empty value` };
      }
      if (k.startsWith("UTM_") || k !== k.toLowerCase()) {
        return { issue_type: "malformed", severity: "info", details: `${k} should be lowercase` };
      }
    }
    return null;
  } catch {
    return { issue_type: "malformed", severity: "info", details: "unparseable URL" };
  }
}

export async function utmHygieneScan(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const issues: Issue[] = [];
  const urlToCampaigns = new Map<string, Set<string>>();

  const assets = rows<{ id: string; title: string; html: string | null }>(
    await db.execute(sql`SELECT id, title, html FROM agnb.marketing_assets LIMIT 500`)
  );
  for (const a of assets) {
    for (const url of extractUrls(a.html ?? "")) {
      const issue = checkUrl(url);
      if (issue) issues.push({ source_kind: "marketing_asset", source_id: a.id, source_name: a.title, url, ...issue });
      try {
        const u = new URL(url);
        const campaign = u.searchParams.get("utm_campaign");
        if (campaign) {
          const baseUrl = `${u.origin}${u.pathname}`;
          const set = urlToCampaigns.get(baseUrl) ?? new Set();
          set.add(campaign);
          urlToCampaigns.set(baseUrl, set);
        }
      } catch { /* skip */ }
    }
  }

  const blogs = rows<{ id: string; title: string; mdx_body: string | null }>(
    await db.execute(sql`SELECT id, title, mdx_body FROM agnb.blog_drafts LIMIT 500`)
  );
  for (const b of blogs) {
    for (const url of extractUrls(b.mdx_body ?? "")) {
      const issue = checkUrl(url);
      if (issue) issues.push({ source_kind: "blog_draft", source_id: b.id, source_name: b.title, url, ...issue });
    }
  }

  for (const [baseUrl, campaigns] of urlToCampaigns.entries()) {
    if (campaigns.size > 1) {
      issues.push({
        source_kind: "marketing_asset", source_id: "global", source_name: "(cross-asset)",
        url: baseUrl, issue_type: "inconsistent_campaign", severity: "warn",
        details: `${campaigns.size} different utm_campaign values: ${Array.from(campaigns).join(", ")}`,
      });
    }
  }

  let upserts = 0;
  const stillExisting = new Set<string>();
  for (const i of issues) {
    if (ctx.signal.aborted) break;
    stillExisting.add(`${i.source_kind}:${i.source_id}:${i.url}`);
    const r = await db.execute(sql`
      INSERT INTO agnb.utm_hygiene_issues
        (source_kind, source_id, source_name, url, issue_type, severity, details, detected_at, resolved_at)
      VALUES (${i.source_kind}, ${i.source_id}, ${i.source_name}, ${i.url}, ${i.issue_type}, ${i.severity}, ${i.details}, now(), NULL)
      ON CONFLICT (source_kind, source_id, url) DO UPDATE SET
        source_name = EXCLUDED.source_name,
        issue_type = EXCLUDED.issue_type,
        severity = EXCLUDED.severity,
        details = EXCLUDED.details,
        detected_at = now(),
        resolved_at = NULL
    `);
    upserts += (r as { rowCount?: number })?.rowCount ?? 0;
  }

  const unresolved = rows<{ id: string; source_kind: string; source_id: string; url: string }>(
    await db.execute(sql`
      SELECT id, source_kind, source_id, url FROM agnb.utm_hygiene_issues WHERE resolved_at IS NULL
    `)
  );
  let resolved = 0;
  for (const u of unresolved) {
    if (ctx.signal.aborted) break;
    if (!stillExisting.has(`${u.source_kind}:${u.source_id}:${u.url}`)) {
      await db.execute(sql`UPDATE agnb.utm_hygiene_issues SET resolved_at = now() WHERE id = ${u.id}`);
      resolved++;
    }
  }

  ctx.log("utm hygiene scan done", { assets: assets.length, blogs: blogs.length, issues: issues.length, upserts, resolved });
  return {
    ok: true,
    assets_scanned: assets.length,
    blogs_scanned: blogs.length,
    issues_found: issues.length,
    upserts,
    auto_resolved: resolved,
    summary: `${issues.length} issues across ${assets.length + blogs.length} sources`,
  };
}
