import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issueApprovals, issueWorkProducts } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const EXECUTOR_EXTERNAL_ID = "katya_publish_executor_v1";
const BLOG_URL_PLACEHOLDER = "{{BLOG_URL_CANONICAL}}";
const BLOG_PLACEHOLDER_RE = /\{\{BLOG_URL_CANONICAL\}\}/g;

const DRAFT_FIELDS = ["draft", "draft_full", "linkUrl"] as const;

export interface KatyaPublishExecutorTickResult {
  checked: number;
  blogsDiscovered: number;
  socialsSubstituted: number;
  socialsDeferred: number;
  errors: number;
}

function extractChannel(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  const v = payload.channel;
  return typeof v === "string" ? v : null;
}

function extractCanonicalUrl(payload: Record<string, unknown> | null | undefined): string | null {
  if (!payload) return null;
  for (const key of ["publishedUrl", "proofUrl", "postUrl", "url"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.trim().startsWith("https://")) return v.trim();
  }
  return null;
}

function hasBlogUrlPlaceholder(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  return DRAFT_FIELDS.some((field) => {
    const v = payload[field];
    return typeof v === "string" && v.includes(BLOG_URL_PLACEHOLDER);
  });
}

function substituteBlogUrl(
  payload: Record<string, unknown>,
  canonicalUrl: string,
): Record<string, unknown> {
  const updated = { ...payload };
  for (const field of DRAFT_FIELDS) {
    const v = updated[field];
    if (typeof v === "string" && v.includes(BLOG_URL_PLACEHOLDER)) {
      updated[field] = v.replace(BLOG_PLACEHOLDER_RE, canonicalUrl);
    }
  }
  return updated;
}

/**
 * Server-side publish gate for Katya content approvals.
 *
 * On each tick:
 * 1. Finds all active katya_publish_executor_v1 work products.
 * 2. Separates them into blog items (channel === "blog") and social items.
 * 3. Processes blog items first to discover canonical URLs.
 * 4. For social items whose draft contains {{BLOG_URL_CANONICAL}}:
 *    - Looks up the linked blog approval on the same issue.
 *    - If the blog has a live canonical URL: substitutes {{BLOG_URL_CANONICAL}} in the
 *      social approval payload (draft, draft_full, linkUrl) and persists the update.
 *    - If the blog URL is missing or malformed: defers — logs the reason and leaves the
 *      work product active so it is re-evaluated on the next pass.
 * 5. Social items with no placeholder are skipped (no blog dependency).
 * 6. Non-content approval types are never touched.
 */
export async function tickKatyaPublishExecutor(
  db: Db,
  _now: Date = new Date(),
): Promise<KatyaPublishExecutorTickResult> {
  const result: KatyaPublishExecutorTickResult = {
    checked: 0,
    blogsDiscovered: 0,
    socialsSubstituted: 0,
    socialsDeferred: 0,
    errors: 0,
  };

  // ── Step 1: find all active executor work products ────────────────────────
  const activeWPs = await db
    .select({
      id: issueWorkProducts.id,
      issueId: issueWorkProducts.issueId,
      companyId: issueWorkProducts.companyId,
      metadata: issueWorkProducts.metadata,
    })
    .from(issueWorkProducts)
    .where(
      and(
        eq(issueWorkProducts.externalId, EXECUTOR_EXTERNAL_ID),
        eq(issueWorkProducts.status, "active"),
      ),
    );

  if (activeWPs.length === 0) return result;
  result.checked = activeWPs.length;

  // ── Step 2: batch-fetch the linked approvals ──────────────────────────────
  const approvalIds = activeWPs
    .map((wp) => {
      const meta = wp.metadata as Record<string, unknown> | null;
      return typeof meta?.approvalId === "string" ? meta.approvalId : null;
    })
    .filter((id): id is string => id !== null);

  if (approvalIds.length === 0) return result;

  const approvalRows = await db
    .select({
      id: approvals.id,
      companyId: approvals.companyId,
      type: approvals.type,
      status: approvals.status,
      payload: approvals.payload,
    })
    .from(approvals)
    .where(inArray(approvals.id, approvalIds));

  const approvalById = new Map(approvalRows.map((a) => [a.id, a]));

  // ── Step 3: partition work products into blog vs. social ──────────────────
  type WPEntry = (typeof activeWPs)[number];
  type ApprovalRow = (typeof approvalRows)[number];

  interface AnnotatedWP {
    wp: WPEntry;
    approval: ApprovalRow;
    channel: string;
  }

  const blogItems: AnnotatedWP[] = [];
  const socialItems: AnnotatedWP[] = [];

  for (const wp of activeWPs) {
    const meta = wp.metadata as Record<string, unknown> | null;
    const approvalId = typeof meta?.approvalId === "string" ? meta.approvalId : null;
    if (!approvalId) continue;
    const approval = approvalById.get(approvalId);
    if (!approval) continue;
    const channel = extractChannel(approval.payload);
    if (!channel) continue;

    if (channel === "blog") {
      blogItems.push({ wp, approval, channel });
    } else if (channel === "linkedin" || channel === "x") {
      socialItems.push({ wp, approval, channel });
    }
  }

  // ── Step 4: process blog items — build a map of issue → canonical URL ─────
  // Blogs are processed first so any URL discovered this pass is available
  // when we check socials below.
  const blogUrlByIssueId = new Map<string, string>();

  for (const { wp, approval } of blogItems) {
    const url = extractCanonicalUrl(approval.payload as Record<string, unknown> | null);
    if (url) {
      blogUrlByIssueId.set(wp.issueId, url);
      result.blogsDiscovered += 1;
      logger.debug(
        { issueId: wp.issueId, approvalId: approval.id, url },
        "katya-publish-executor: blog canonical URL discovered",
      );
    }
  }

  // For issues that had blog WPs but no URL in the approval payload yet,
  // fall back to the launch checklist work product's proof field.
  const issuesMissingUrl = blogItems
    .map((b) => b.wp.issueId)
    .filter((id) => !blogUrlByIssueId.has(id));

  if (issuesMissingUrl.length > 0) {
    const launchChecklists = await db
      .select({
        issueId: issueWorkProducts.issueId,
        metadata: issueWorkProducts.metadata,
      })
      .from(issueWorkProducts)
      .where(
        and(
          inArray(issueWorkProducts.issueId, issuesMissingUrl),
          eq(issueWorkProducts.externalId, "launch_checklist_v1"),
        ),
      );

    for (const lc of launchChecklists) {
      const meta = lc.metadata as Record<string, unknown> | null;
      const proof = meta?.proof as Record<string, unknown> | null | undefined;
      const urlOrPostId = typeof proof?.urlOrPostId === "string" ? proof.urlOrPostId.trim() : null;
      if (urlOrPostId && urlOrPostId.startsWith("https://") && !blogUrlByIssueId.has(lc.issueId)) {
        blogUrlByIssueId.set(lc.issueId, urlOrPostId);
        result.blogsDiscovered += 1;
        logger.debug(
          { issueId: lc.issueId, url: urlOrPostId },
          "katya-publish-executor: blog canonical URL found via launch checklist",
        );
      }
    }
  }

  // ── Step 5: process social items ──────────────────────────────────────────
  for (const { wp, approval } of socialItems) {
    try {
      const payload = approval.payload as Record<string, unknown>;
      if (!hasBlogUrlPlaceholder(payload)) continue;

      // Prefer URL already found from blog WPs on this issue.
      let canonicalUrl = blogUrlByIssueId.get(wp.issueId) ?? null;

      if (!canonicalUrl) {
        // Not found via blog WP — query issueApprovals directly for the blog approval.
        const linkedBlogApprovals = await db
          .select({
            id: approvals.id,
            payload: approvals.payload,
          })
          .from(approvals)
          .innerJoin(issueApprovals, eq(issueApprovals.approvalId, approvals.id))
          .where(
            and(
              eq(issueApprovals.issueId, wp.issueId),
              eq(approvals.status, "approved"),
              sql`${approvals.payload}->>'channel' = 'blog'`,
            ),
          );

        for (const blogApproval of linkedBlogApprovals) {
          const url = extractCanonicalUrl(blogApproval.payload as Record<string, unknown> | null);
          if (url) {
            canonicalUrl = url;
            blogUrlByIssueId.set(wp.issueId, url);
            result.blogsDiscovered += 1;
            break;
          }
        }
      }

      if (!canonicalUrl) {
        // Blog not published yet (or URL missing/malformed) — defer.
        result.socialsDeferred += 1;
        logger.info(
          {
            socialApprovalId: approval.id,
            issueId: wp.issueId,
            channel: approval.payload ? (approval.payload as Record<string, unknown>).channel : null,
            reason: "blog_canonical_url_not_available",
          },
          "katya-publish-executor: social approval deferred — waiting for blog canonical URL",
        );

        // Record deferral in work product metadata so callers can observe it.
        await db
          .update(issueWorkProducts)
          .set({
            metadata: sql`${issueWorkProducts.metadata} || ${JSON.stringify({
              lastDeferredAt: new Date().toISOString(),
              deferralReason: "blog_canonical_url_not_available",
            })}::jsonb`,
            updatedAt: new Date(),
          })
          .where(eq(issueWorkProducts.id, wp.id));

        continue;
      }

      // Blog URL available — substitute in social approval payload.
      const updatedPayload = substituteBlogUrl(payload, canonicalUrl);

      await db
        .update(approvals)
        .set({
          payload: updatedPayload,
          updatedAt: new Date(),
        })
        .where(eq(approvals.id, approval.id));

      // Clear any previous deferral metadata and record the resolved URL.
      await db
        .update(issueWorkProducts)
        .set({
          metadata: sql`(${issueWorkProducts.metadata} - 'lastDeferredAt' - 'deferralReason') || ${JSON.stringify({
            blogUrlResolvedAt: new Date().toISOString(),
            resolvedBlogUrl: canonicalUrl,
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(issueWorkProducts.id, wp.id));

      result.socialsSubstituted += 1;
      logger.info(
        {
          socialApprovalId: approval.id,
          issueId: wp.issueId,
          channel: payload.channel,
          canonicalUrl,
        },
        "katya-publish-executor: substituted blog canonical URL in social approval",
      );
    } catch (err) {
      result.errors += 1;
      logger.error(
        { err, socialApprovalId: approval.id, issueId: wp.issueId },
        "katya-publish-executor: error processing social work product",
      );
    }
  }

  if (result.socialsDeferred > 0 || result.socialsSubstituted > 0 || result.blogsDiscovered > 0) {
    logger.info(result, "katya-publish-executor tick complete");
  }

  return result;
}
