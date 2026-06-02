import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { rows } from "../helpers.js";
import type { AgnbJobContext, AgnbJobResult } from "./types.js";

/**
 * content-audit — scans content/blog/*.mdx for issues (stale_year, thin_content,
 * no_image, no_faq, broken_link, needs_refresh) and upserts/resolves rows in
 * agnb.content_audit_issues. Ported from agnb api/internal/content-audit.
 *
 * NOTE: the MDX tree lives in the original Next.js repo, not the Paperclip
 * server. If content/blog is absent the job no-ops gracefully. Set
 * SKIP_LINK_CHECK=1 to skip the (slow) external-link HEAD checks.
 */

const CURRENT_YEAR = new Date().getFullYear();
const STALE_YEAR_THRESHOLD = CURRENT_YEAR - 2;
const THIN_WORD_THRESHOLD = 600;
const MAX_LINK_CHECKS_PER_POST = 5;

type Issue = { issue_type: string; severity: "info" | "warn" | "fail"; details: string };

async function auditPost(content: string, signal: AbortSignal): Promise<Issue[]> {
  const issues: Issue[] = [];
  const fm = content.match(/^---([\s\S]*?)---/m)?.[1] ?? "";
  const body = content.replace(/^---[\s\S]*?---\s*/m, "").trim();
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  // Age-based refresh flagging
  const date = fm.match(/^date:\s*["']?([\d-]+)["']?/m)?.[1];
  const clusterType = fm.match(/^cluster_type:\s*["']?(\w+)["']?/m)?.[1] ?? "standalone";
  if (date) {
    const ageDays = Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
    const refreshThreshold = clusterType === "pillar" ? 90 : 180;
    if (ageDays > refreshThreshold) {
      issues.push({ issue_type: "needs_refresh", severity: "info", details: `${ageDays} days old (${clusterType} threshold ${refreshThreshold}d)` });
    }
  }

  // Thin content
  if (wordCount < THIN_WORD_THRESHOLD) {
    issues.push({ issue_type: "thin_content", severity: "warn", details: `${wordCount} words (threshold ${THIN_WORD_THRESHOLD})` });
  }

  // Stale year
  const staleYears = new Set<string>();
  for (const m of body.matchAll(/\b(20[0-2]\d)\b/g)) {
    const yr = parseInt(m[1], 10);
    if (yr <= STALE_YEAR_THRESHOLD && yr >= 2018) staleYears.add(m[1]);
  }
  if (staleYears.size > 0) {
    issues.push({ issue_type: "stale_year", severity: "info", details: `references ${Array.from(staleYears).join(", ")} (current ${CURRENT_YEAR})` });
  }

  // No image
  const hasImage = /!\[[^\]]*\]\([^)]+\)|<img\s/.test(body);
  if (!hasImage) issues.push({ issue_type: "no_image", severity: "warn", details: "no inline images" });

  // No FAQ
  const hasFaq = /^##\s+Frequently Asked Questions/im.test(body);
  if (!hasFaq) issues.push({ issue_type: "no_faq", severity: "info", details: "no FAQ section (helps SEO)" });

  // Broken external links (optional)
  if (process.env.SKIP_LINK_CHECK !== "1") {
    const urls = Array.from(body.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/g)).map((m) => m[1]);
    const unique = Array.from(new Set(urls)).slice(0, MAX_LINK_CHECKS_PER_POST);
    for (const u of unique) {
      if (signal.aborted) break;
      try {
        const r = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(8_000), redirect: "follow" });
        if (r.status >= 400) issues.push({ issue_type: "broken_link", severity: "warn", details: `${r.status} → ${u}` });
      } catch {
        issues.push({ issue_type: "broken_link", severity: "warn", details: `unreachable → ${u}` });
      }
    }
  }

  return issues;
}

export async function contentAudit(ctx: AgnbJobContext): Promise<AgnbJobResult> {
  const { db } = ctx;
  const blogDir = join(process.cwd(), "content", "blog");

  let files: string[];
  try {
    files = (await readdir(blogDir)).filter((f) => f.endsWith(".mdx"));
  } catch {
    return { ok: true, processed: 0, summary: "content/blog dir not found — nothing to audit" };
  }

  let postsAudited = 0;
  let issuesFound = 0;
  let issuesResolved = 0;
  const newByType: Record<string, number> = {};

  for (const f of files) {
    if (ctx.signal.aborted) break;
    const blogPath = `content/blog/${f}`;
    const text = await readFile(join(blogDir, f), "utf8");
    const title = text.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "";

    const detected = await auditPost(text, ctx.signal);
    const detectedTypes = new Set(detected.map((d) => d.issue_type));

    for (const issue of detected) {
      await db.execute(sql`
        INSERT INTO agnb.content_audit_issues
          (blog_path, blog_title, issue_type, severity, details, detected_at, resolved_at)
        VALUES (${blogPath}, ${title}, ${issue.issue_type}, ${issue.severity}, ${issue.details}, now(), NULL)
        ON CONFLICT (blog_path, issue_type) DO UPDATE
          SET blog_title = EXCLUDED.blog_title,
              severity = EXCLUDED.severity,
              details = EXCLUDED.details,
              detected_at = now(),
              resolved_at = NULL
      `);
      issuesFound++;
      newByType[issue.issue_type] = (newByType[issue.issue_type] ?? 0) + 1;
    }

    const existing = rows<{ id: string; issue_type: string }>(
      await db.execute(sql`
        SELECT id, issue_type FROM agnb.content_audit_issues
        WHERE blog_path = ${blogPath} AND resolved_at IS NULL
      `),
    );
    for (const e of existing) {
      if (!detectedTypes.has(e.issue_type)) {
        await db.execute(sql`
          UPDATE agnb.content_audit_issues SET resolved_at = now() WHERE id = ${e.id}
        `);
        issuesResolved++;
      }
    }

    postsAudited++;
  }

  ctx.log("content audit complete", { postsAudited, issuesFound, issuesResolved });
  return {
    ok: true,
    processed: postsAudited,
    posts_audited: postsAudited,
    issues_found: issuesFound,
    issues_resolved: issuesResolved,
    new_by_type: newByType,
    summary: `${postsAudited} posts · ${issuesFound} issues · ${issuesResolved} resolved`,
  };
}
