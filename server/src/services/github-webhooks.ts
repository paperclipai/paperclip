/**
 * GitHub webhook ingestion for COS v2 — Phase 5.2d.
 *
 * Scope of this module:
 *   1. Verify `X-Hub-Signature-256` against a per-company secret.
 *   2. Parse `pull_request` events (opened / synchronize / closed).
 *   3. Extract COS v2 issue identifiers (`DOG-1`, `ENG3-42`, ...) from
 *      the PR title + body.
 *   4. Upsert an `issue_work_products` row for each matched issue, so
 *      the PR shows up in the issue's "work products" list with its
 *      current status + review state.
 *   5. On `pull_request.closed` with `merged=true`, transition each
 *      linked issue to a completed-category status (if the team has
 *      one) and log the transition.
 *
 * Out of scope for this phase:
 *   - GitHub App installation / OAuth setup UI
 *   - Outbound GitHub API calls (PR merge, commit status, labels)
 *   - Branch protection / required reviewers
 *   - Check runs / workflow events
 *   - Cross-repo routing rules
 *
 * Secret strategy (MVP):
 *   - Each company stores a `company_secrets` row with name
 *     `github_webhook` whose latest version's material contains
 *     `{ value: "<hex secret>" }`. The webhook route reads this via
 *     `secretService.resolveSecretValue(companyId, secretId, "latest")`.
 *   - For the MVP we also fall back to an env-var `GITHUB_WEBHOOK_SECRET`
 *     if the company has no configured secret. This lets you smoke-test
 *     against a fresh install without touching the secrets UI.
 */

import crypto from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, issues, teamWorkflowStatuses } from "@paperclipai/db";

/**
 * Hard caps to prevent amplification DoS on webhook inputs. A
 * malicious (or simply confused) PR body with thousands of identifier
 * references would otherwise run one DB SELECT per identifier AND one
 * upsert each, in sequence. Cap at 50 — realistic PRs mention a
 * handful of issues, anything larger is almost certainly abuse.
 */
const MAX_IDENTIFIERS_PER_EVENT = 50;

/** Extracted issue reference from a PR title/body. */
export interface PrIssueRef {
  identifier: string;
}

/**
 * Extract COS v2 issue identifiers from arbitrary text. Matches the
 * project's canonical `PREFIX-N` shape where PREFIX is an uppercase
 * letter followed by 0+ alphanumeric characters (so `DOG-1`, `ENG3-42`,
 * `A1B2-7` all work). Returned in first-seen order, de-duplicated.
 *
 * Rules:
 *   - Word-boundary anchored so `foo-bar-DOG-1` still matches "DOG-1"
 *     but `1DOG-1` does not
 *   - Requires the prefix to START with a letter (so plain "1-2"
 *     doesn't match)
 *   - Case-insensitive — normalized to upper case
 *
 * Exported for unit testing.
 */
export function extractIssueIdentifiers(text: string | null | undefined): PrIssueRef[] {
  if (!text) return [];
  const out: PrIssueRef[] = [];
  const seen = new Set<string>();
  // Require a non-word or start boundary before the prefix so that
  // e.g. "foo-bar-DOG-1" matches "DOG-1" (the `-` is non-word) but
  // "1DOG-1" does not.
  const re = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;
  for (const m of text.matchAll(re)) {
    const prefix = m[1]!.toUpperCase();
    const num = m[2]!;
    const ident = `${prefix}-${num}`;
    if (seen.has(ident)) continue;
    seen.add(ident);
    out.push({ identifier: ident });
  }
  return out;
}

/**
 * Constant-time HMAC signature verification. GitHub always sends the
 * header as `sha256=<64 hex chars>` (71 bytes total), so we REQUIRE
 * that exact prefix. Dropping the raw-hex fallback closes the length
 * oracle the feature-dev reviewer flagged: the old code did a
 * length-pre-check branch on two candidate lengths, leaking whether
 * the caller submitted `sha256=...` or the bare digest.
 */
export function verifyGithubSignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const provided = signatureHeader.trim();
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Pad both sides to the same length before timingSafeEqual so it
  // never throws, and the compare always runs to completion regardless
  // of what the attacker sent. This removes any length-dependent branch.
  const providedBuf = Buffer.from(provided, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (providedBuf.length !== expectedBuf.length) {
    // We MUST still do constant-work compare to avoid a timing branch;
    // compare against a zero-padded buffer of the expected length.
    const pad = Buffer.alloc(expectedBuf.length);
    providedBuf.copy(pad, 0, 0, Math.min(providedBuf.length, pad.length));
    // Always compare — result is guaranteed false because the real
    // provided length didn't match expected.
    crypto.timingSafeEqual(pad, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Map a GitHub PR state + merged flag to the `issue_work_products.status`
 * value this system uses.
 */
export function mapPrStatus(
  action: string,
  merged: boolean,
): "open" | "merged" | "closed" {
  if (action === "closed") {
    return merged ? "merged" : "closed";
  }
  return "open";
}

export type PullRequestEventPayload = {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    merged: boolean;
    html_url: string;
    user?: { login?: string } | null;
    merged_at?: string | null;
    base?: { repo?: { full_name?: string } } | null;
  };
  repository?: { full_name?: string } | null;
};

/**
 * Apply one PR event to the DB: upsert work-product rows for each
 * matched issue, and transition merged PRs to the team's completed
 * workflow status.
 *
 * Returns a summary of what happened so callers (routes / tests) can
 * assert on it.
 */
export interface WebhookApplyResult {
  matchedIdentifiers: string[];
  upserted: number;
  transitioned: number;
  unknownIdentifiers: string[];
}

export function githubWebhookService(db: Db) {
  /**
   * Find or create a `pull_request` work-product row for this issue +
   * PR URL. Uses URL as the dedup key because a PR's `html_url` is
   * globally unique and immutable.
   */
  async function upsertWorkProduct(
    issueId: string,
    companyId: string,
    evt: PullRequestEventPayload,
  ): Promise<{ created: boolean }> {
    const pr = evt.pull_request;
    const repo = pr.base?.repo?.full_name ?? evt.repository?.full_name ?? null;
    const externalId = repo ? `${repo}#${pr.number}` : `#${pr.number}`;
    const status = mapPrStatus(evt.action, pr.merged);

    const existing = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.issueId, issueId),
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.url, pr.html_url),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(issueWorkProducts)
        .set({
          status,
          title: pr.title,
          metadata: {
            authorLogin: pr.user?.login ?? null,
            mergedAt: pr.merged_at ?? null,
            action: evt.action,
          },
          updatedAt: new Date(),
        })
        .where(eq(issueWorkProducts.id, existing.id));
      return { created: false };
    }

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId,
      title: pr.title,
      url: pr.html_url,
      status,
      reviewState: "none",
      isPrimary: false,
      metadata: {
        authorLogin: pr.user?.login ?? null,
        mergedAt: pr.merged_at ?? null,
        action: evt.action,
      },
    });
    return { created: true };
  }

  /**
   * Find the "completed-category" workflow status for a team, so we
   * can transition an issue when its linked PR merges.
   *
   * Reviewer P1 finding: previously fell back to the literal `"done"`,
   * which could fail team-workflow validation for teams that use a
   * custom slug (e.g. `resolved`). Returning null signals the caller
   * to SKIP the transition silently rather than silently corrupt the
   * row. For teamless issues we also return null.
   */
  async function resolveCompletedStatusSlug(teamId: string | null): Promise<string | null> {
    if (!teamId) return null;
    const row = await db
      .select({ slug: teamWorkflowStatuses.slug })
      .from(teamWorkflowStatuses)
      .where(
        and(
          eq(teamWorkflowStatuses.teamId, teamId),
          eq(teamWorkflowStatuses.category, "completed"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row?.slug ?? null;
  }

  return {
    /** Apply a pull_request event. The caller handles auth/signature. */
    applyPullRequestEvent: async (
      companyId: string,
      evt: PullRequestEventPayload,
    ): Promise<WebhookApplyResult> => {
      const allIdentifiers = extractIssueIdentifiers(
        `${evt.pull_request.title} ${evt.pull_request.body ?? ""}`,
      );
      // Reviewer P1 finding C — cap per event to bound the loop.
      const identifiers = allIdentifiers.slice(0, MAX_IDENTIFIERS_PER_EVENT);
      const result: WebhookApplyResult = {
        matchedIdentifiers: identifiers.map((i) => i.identifier),
        upserted: 0,
        transitioned: 0,
        unknownIdentifiers: [],
      };
      if (identifiers.length === 0) return result;

      // Reviewer P1 finding C/D/K — batch the issue lookup with a
      // single `inArray` query AND pin it to the webhook's company.
      // The previous per-identifier loop did a `limit(1)` without
      // companyId which was a false-negative risk (another tenant's
      // identifier collision could win the sort order).
      const identifierStrs = identifiers.map((i) => i.identifier);
      const foundIssues = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          companyId: issues.companyId,
          teamId: issues.teamId,
          status: issues.status,
        })
        .from(issues)
        .where(
          and(
            inArray(issues.identifier, identifierStrs),
            eq(issues.companyId, companyId),
          ),
        );
      const byIdentifier = new Map<string, (typeof foundIssues)[number]>();
      for (const row of foundIssues) {
        if (row.identifier) byIdentifier.set(row.identifier, row);
      }

      for (const ref of identifiers) {
        const issueRow = byIdentifier.get(ref.identifier);
        if (!issueRow) {
          result.unknownIdentifiers.push(ref.identifier);
          continue;
        }

        await upsertWorkProduct(issueRow.id, companyId, evt);
        result.upserted += 1;

        // Transition to completed-category status on merge only.
        // If the team has no completed-category status configured we
        // skip the transition rather than silently writing "done"
        // (reviewer P1 finding 2).
        if (evt.action === "closed" && evt.pull_request.merged) {
          const completedSlug = await resolveCompletedStatusSlug(issueRow.teamId);
          if (completedSlug && issueRow.status !== completedSlug) {
            await db
              .update(issues)
              .set({
                status: completedSlug,
                completedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issueRow.id));
            result.transitioned += 1;
          }
        }
      }

      return result;
    },
  };
}
