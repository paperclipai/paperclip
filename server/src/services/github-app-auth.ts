/**
 * Minimal GitHub App auth + PR-review evidence verification (BLO-10448).
 *
 * The PR-review completion guard (`evaluatePrReviewCompletionEvidence` in
 * heartbeat.ts) is a text heuristic over the agent's free-text summary; it
 * flags `pr_review_output_missing` whenever the summary lacks a recognized
 * posted-review / skip marker. In practice that misfires on legitimate runs
 * (idempotency skips, comment-mode reviews) — the PR *was* reviewed, but the
 * phrasing wasn't matched. This module lets the server check the authoritative
 * source — GitHub — before keeping that `missing` verdict.
 *
 * The server has no ambient GitHub token, so we mint short-lived **installation
 * tokens** from the GitHub App creds (`paperclip-github-app-creds`, surfaced via
 * GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY). Uses only
 * node:crypto for the RS256 App JWT — no extra dependency. When creds are absent
 * every entrypoint degrades to null/`{error}`, so callers fall back to the
 * pre-existing heuristic result (the feature is purely additive and can only
 * rescue a false `missing`, never downgrade a success).
 */
import { createSign } from "node:crypto";

import { loadConfig } from "../config.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

const GITHUB_HOST = "github.com";
const GITHUB_API_HEADERS = { accept: "application/vnd.github+json" } as const;
// Refresh the installation token this long before its stated expiry so an
// in-flight request never races the 1h boundary.
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize a GitHub author handle to a bare slug: strips a leading `@` or
 * `app/`, a trailing `[bot]`, and lowercases. Mirrors the heuristic guard's
 * `normalizeGithubAuthorHandle` (kept local to avoid a heartbeat.ts import cycle).
 */
export function normalizeGithubLogin(login: string): string {
  return login
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "")
    .trim();
}

/**
 * Mint an RS256 GitHub App JWT (valid ~9 min). Returns null when the App id or
 * private key is unconfigured.
 */
export function mintAppJwt(nowMs: number = Date.now()): string | null {
  const cfg = loadConfig();
  const appId = cfg.githubAppId.trim();
  const privateKey = cfg.githubAppPrivateKey;
  if (!appId || !privateKey.trim()) return null;

  const nowSec = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat back-dated 30s to tolerate minor clock skew; exp +9 min (GitHub caps at 10).
  const payload = base64Url(JSON.stringify({ iat: nowSec - 30, exp: nowSec + 540, iss: appId }));
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    return `${header}.${payload}.${base64Url(signer.sign(privateKey))}`;
  } catch {
    return null;
  }
}

let cachedInstallationToken: { token: string; expiresAtMs: number } | null = null;

/** Test-only: drop the cached installation token. */
export function _resetInstallationTokenCache(): void {
  cachedInstallationToken = null;
}

/**
 * Return a cached or freshly-minted installation access token, or null when
 * creds are absent or the GitHub API call fails.
 */
export async function getInstallationToken(nowMs: number = Date.now()): Promise<string | null> {
  if (cachedInstallationToken && cachedInstallationToken.expiresAtMs - TOKEN_REFRESH_SKEW_MS > nowMs) {
    return cachedInstallationToken.token;
  }
  const cfg = loadConfig();
  const installationId = cfg.githubAppInstallationId.trim();
  const jwt = mintAppJwt(nowMs);
  if (!jwt || !installationId) return null;

  const url = `${gitHubApiBase(GITHUB_HOST)}/app/installations/${installationId}/access_tokens`;
  let res: Response;
  try {
    res = await ghFetch(url, {
      method: "POST",
      headers: { ...GITHUB_API_HEADERS, authorization: `Bearer ${jwt}` },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { token?: string; expires_at?: string } | null;
  if (!body?.token) return null;

  const parsedExpiry = body.expires_at ? Date.parse(body.expires_at) : NaN;
  cachedInstallationToken = {
    token: body.token,
    expiresAtMs: Number.isFinite(parsedExpiry) ? parsedExpiry : nowMs + 30 * 60 * 1000,
  };
  return cachedInstallationToken.token;
}

export type ReviewerEvidenceResult =
  | { found: true; via: "review" | "comment" }
  | { found: false }
  | { error: string };

/** Extract the leading 7-40 hex chars of a head SHA, or null. */
function headShaHex(headSha: string | null | undefined): string | null {
  if (!headSha) return null;
  return headSha.match(/^[0-9a-f]{7,40}/i)?.[0]?.toLowerCase() ?? null;
}

/**
 * Fetch the PR's current head SHA. Used only as a fallback when the wake didn't
 * carry one (BLO-10878): a null head SHA used to disable the comment-mode check
 * entirely (`headPrefix` null), so comment-mode reviews on PRs whose wake lacked
 * a head SHA were never recognized → false `pr_review_output_missing`. Returns
 * null on any non-OK / failed fetch so the caller keeps its lenient fallback.
 */
async function fetchPrHeadSha(
  apiBase: string,
  repoFullName: string,
  prNumber: number,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await ghFetch(`${apiBase}/repos/${repoFullName}/pulls/${prNumber}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { head?: { sha?: string } } | null;
    const sha = body?.head?.sha;
    return typeof sha === "string" ? headShaHex(sha) : null;
  } catch {
    return null;
  }
}

// BLO-10878 cause #2: cap the at-or-newer `compare` fan-out so a comment-heavy PR
// (many embedded hex strings) can't trigger an unbounded number of API calls.
const MAX_AT_OR_NEWER_COMPARES = 10;

/**
 * GitHub commit comparison status of `head` relative to `base`
 * (`ahead` | `behind` | `identical` | `diverged`), or null on any non-OK / failed
 * fetch. An unknown SHA (e.g. a non-commit hex scraped from a comment) 404s → null,
 * so the caller simply skips that candidate rather than failing the whole check.
 */
async function compareCommitStatus(
  apiBase: string,
  repoFullName: string,
  baseSha: string,
  headSha: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await ghFetch(`${apiBase}/repos/${repoFullName}/compare/${baseSha}...${headSha}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return typeof body?.status === "string" ? body.status : null;
  } catch {
    return null;
  }
}

/** Unique candidate git-SHA hex runs (7-40 chars, hex-bounded) embedded in text. */
function extractCandidateShas(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/gi)) {
    const sha = match[0].toLowerCase();
    if (!seen.has(sha)) {
      seen.add(sha);
      out.push(sha);
    }
  }
  return out;
}

/**
 * Authoritatively check whether the reviewer bot left a review or comment for
 * THIS PR head on GitHub. Used to rescue a false `pr_review_output_missing`.
 *
 * Found when either:
 *  - a review authored by the bot has `commit_id === headSha` (precise: reviewed
 *    this exact head), or
 *  - an issue comment authored by the bot references the head SHA prefix in its
 *    body (covers comment-mode reviews on bot-authored PRs, which carry no
 *    commit_id).
 *
 * If no exact-head match is found, a second pass (BLO-10878 cause #2) credits a
 * bot review/comment whose head is a DESCENDANT of the wake head — the PR
 * commonly advances between the reviewer-wake and the review, so Ally reviews a
 * newer commit than the one the wake carried. Each off-head candidate SHA is
 * checked with GitHub `compare` and accepted only when the candidate is "ahead"
 * of (or "identical" to) the wake head; "behind"/"diverged" are rejected, so a
 * genuinely-unreviewed newer head still flags. Bounded by MAX_AT_OR_NEWER_COMPARES.
 *
 * Returns `{error}` on missing creds / token / any non-OK or failed reviews/
 * comments fetch so the caller can fall back to the heuristic verdict. (A failed
 * `compare` only skips that candidate — the second pass is purely additive and can
 * never downgrade a verdict.)
 */
export async function githubHasReviewerEvidenceForPr(input: {
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
}): Promise<ReviewerEvidenceResult> {
  const cfg = loadConfig();
  const botLogin = normalizeGithubLogin(cfg.prReviewerBotLogin);
  if (!botLogin) return { error: "no_bot_login" };

  const token = await getInstallationToken();
  if (!token) return { error: "no_token" };

  const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${token}` };
  const apiBase = gitHubApiBase(GITHUB_HOST);
  // BLO-10878: when the wake didn't carry a head SHA, fall back to the PR's
  // current head so the comment-mode check (keyed on `headPrefix`) still runs.
  // Previously a null head SHA skipped comments entirely and only the formal-
  // review loop ran, missing Ally's frequent comment-mode reviews.
  const headSha =
    headShaHex(input.headSha) ?? (await fetchPrHeadSha(apiBase, input.repoFullName, input.prNumber, headers));
  const headPrefix = headShaHex(headSha);

  // Off-head bot review/comment SHAs collected during the exact-head passes below;
  // consumed by the at-or-newer fallback (cause #2) only when no exact match found.
  const reviewCandidates: string[] = [];
  const commentCandidates: string[] = [];

  // 1) Formal reviews — match the bot author at this exact head commit.
  try {
    for (let page = 1; page <= 10; page += 1) {
      const url = `${apiBase}/repos/${input.repoFullName}/pulls/${input.prNumber}/reviews?per_page=100&page=${page}`;
      const res = await ghFetch(url, { headers });
      if (!res.ok) return { error: `reviews_http_${res.status}` };
      const batch = (await res.json()) as Array<{ user?: { login?: string }; commit_id?: string | null }>;
      for (const review of batch) {
        if (normalizeGithubLogin(review.user?.login ?? "") !== botLogin) continue;
        if (!headSha) return { found: true, via: "review" };
        const commitId = headShaHex(review.commit_id);
        if (commitId === headSha) return { found: true, via: "review" };
        if (commitId) reviewCandidates.push(commitId);
      }
      if (batch.length < 100) break;
    }
  } catch {
    return { error: "reviews_fetch_failed" };
  }

  // 2) Issue comments — bot comment whose body references the head SHA. Match on
  // the 7-char short prefix (allowing any longer hex run) so both short and full
  // SHA forms of THIS head are recognized — same shape as
  // prReviewOutputReferencesSameTarget in heartbeat.ts.
  if (headPrefix) {
    // Boundary on hex chars only (not `\b`): `_` is a `\w` char, so `\b…\b` finds
    // no trailing boundary when Ally embeds the SHA in markdown italics
    // (`_reviewed head: <sha>_`), mis-flagging a real comment-mode review as missing.
    const headRefPattern = new RegExp(`(?<![0-9a-f])${headPrefix.slice(0, 7)}[0-9a-f]*(?![0-9a-f])`);
    try {
      for (let page = 1; page <= 10; page += 1) {
        const url = `${apiBase}/repos/${input.repoFullName}/issues/${input.prNumber}/comments?per_page=100&page=${page}`;
        const res = await ghFetch(url, { headers });
        if (!res.ok) return { error: `comments_http_${res.status}` };
        const batch = (await res.json()) as Array<{ user?: { login?: string }; body?: string }>;
        for (const comment of batch) {
          if (normalizeGithubLogin(comment.user?.login ?? "") !== botLogin) continue;
          const body = (comment.body ?? "").toLowerCase();
          if (headRefPattern.test(body)) return { found: true, via: "comment" };
          for (const sha of extractCandidateShas(body)) commentCandidates.push(sha);
        }
        if (batch.length < 100) break;
      }
    } catch {
      return { error: "comments_fetch_failed" };
    }
  }

  // 3) At-or-newer fallback (BLO-10878 cause #2): no exact-head match, but a bot
  // review/comment may sit on a DESCENDANT of the wake head (the PR advanced
  // between the wake and the review). Check off-head candidates newest-first
  // (reviews, then comments) and credit the first that is "ahead"/"identical";
  // "behind"/"diverged" — and unknown-SHA 404s — are skipped, so a genuinely
  // unreviewed newer head still flags. Compare fan-out is bounded.
  if (headSha) {
    const seen = new Set<string>([headSha]);
    let compares = 0;
    const passes: Array<{ shas: string[]; via: "review" | "comment" }> = [
      { shas: reviewCandidates.slice().reverse(), via: "review" },
      { shas: commentCandidates.slice().reverse(), via: "comment" },
    ];
    for (const { shas, via } of passes) {
      for (const sha of shas) {
        if (compares >= MAX_AT_OR_NEWER_COMPARES) break;
        if (seen.has(sha)) continue;
        seen.add(sha);
        compares += 1;
        const status = await compareCommitStatus(apiBase, input.repoFullName, headSha, sha, headers);
        if (status === "ahead" || status === "identical") return { found: true, via };
      }
    }
  }

  return { found: false };
}
