/**
 * Write-time PATCH gate for status=done transitions (STAA-4122).
 *
 * Rejects a close PATCH with HTTP 422 unless the closing comment contains
 * a valid Path A (shippable), Path B (non-shippable), or Path C (close-override)
 * block. Path C is a placeholder (rejected with close_override_path_not_yet_enabled).
 *
 * Shadow mode: set env DONE_GATE_SHADOW_MODE=true to log rejections without
 * returning 422. Used during P1 dry-run before P2 hard enforcement.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

export const DONE_GATE_SHADOW_MODE = process.env.DONE_GATE_SHADOW_MODE === "true";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERIFIED_AT_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

const PATH_B_ALLOWLIST = new Set([
  "audit",
  "governance",
  "planning",
  "routine",
  "code review",
  "process",
  "triage",
  "legal-action-carrier",
]);

// ---------------------------------------------------------------------------
// SHA verification cache (in-process LRU with 5-min TTL)
// ---------------------------------------------------------------------------

interface ShaCacheEntry {
  exists: boolean;
  fetchedAt: number;
}

const SHA_CACHE_TTL_MS = 5 * 60 * 1000;
const shaCache = new Map<string, ShaCacheEntry>();

function cacheLookup(cacheKey: string): boolean | null {
  const entry = shaCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > SHA_CACHE_TTL_MS) {
    shaCache.delete(cacheKey);
    return null;
  }
  return entry.exists;
}

function cacheSet(cacheKey: string, exists: boolean) {
  shaCache.set(cacheKey, { exists, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Path parsing
// ---------------------------------------------------------------------------

const PATH_A_REGEX = /^verified_live_url:\s*(.+)$/im;
const PATH_A_AT_REGEX = /^verified_at:\s*(.+)$/im;
const PATH_A_SHA_REGEX = /^verified_sha:\s*([0-9a-f]+)$/im;

const PATH_B_REGEX = /^non-shippable:\s*(.+)$/im;

const PATH_C_REGEX = /^close-override:\s*(.+)$/im;

function parsePathA(body: string) {
  const urlMatch = PATH_A_REGEX.exec(body);
  const atMatch = PATH_A_AT_REGEX.exec(body);
  const shaMatch = PATH_A_SHA_REGEX.exec(body);
  if (!urlMatch && !atMatch && !shaMatch) return null;
  return {
    verifiedLiveUrl: urlMatch?.[1]?.trim() ?? null,
    verifiedAt: atMatch?.[1]?.trim() ?? null,
    verifiedSha: shaMatch?.[1]?.trim() ?? null,
  };
}

function parsePathB(body: string) {
  const match = PATH_B_REGEX.exec(body);
  if (!match) return null;
  return { reason: match[1].trim() };
}

function parsePathC(body: string) {
  const match = PATH_C_REGEX.exec(body);
  if (!match) return null;
  return { approvalId: match[1].trim() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/;

function extractGitHubOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const m = GITHUB_HTTPS_RE.exec(repoUrl);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function shaExistsOnMainViaGitHub(
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean | "infra_unavailable"> {
  const cacheKey = `gh:${owner}/${repo}:${sha}`;
  const cached = cacheLookup(cacheKey);
  if (cached !== null) return cached;

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    const exists = res.status === 200;
    cacheSet(cacheKey, exists);
    return exists;
  } catch {
    return "infra_unavailable";
  }
}

async function shaExistsOnMainViaGitLsRemote(
  repoUrl: string,
  sha: string,
): Promise<boolean | "infra_unavailable"> {
  const cacheKey = `ls:${repoUrl}:${sha}`;
  const cached = cacheLookup(cacheKey);
  if (cached !== null) return cached;

  try {
    const { stdout } = await execFileAsync("git", ["ls-remote", repoUrl, "refs/heads/main"], {
      timeout: 8000,
    });
    // stdout format: "<sha>\trefs/heads/main\n"
    const mainSha = stdout.trim().split("\t")[0]?.trim() ?? "";
    // We can only check if verified_sha equals HEAD of main. For merged commits
    // that are not HEAD, fall through to GitHub API.
    if (mainSha.startsWith(sha) || sha.startsWith(mainSha)) {
      cacheSet(cacheKey, true);
      return true;
    }
    // ls-remote only gives HEAD; can't confirm arbitrary ancestors without full fetch
    return "infra_unavailable";
  } catch {
    return "infra_unavailable";
  }
}

// ---------------------------------------------------------------------------
// SHA verification orchestration
// ---------------------------------------------------------------------------

async function verifySha(
  sha: string,
  repoUrl: string | null,
): Promise<"ok" | "not_found" | "infra_unavailable"> {
  if (!repoUrl) return "infra_unavailable";

  const ownerRepo = extractGitHubOwnerRepo(repoUrl);
  if (ownerRepo) {
    // Try GitHub API first (can verify any SHA on the repo, not just HEAD)
    const result = await shaExistsOnMainViaGitHub(ownerRepo.owner, ownerRepo.repo, sha);
    if (result === "infra_unavailable") {
      // GitHub API unavailable — try git ls-remote as last resort
      const lsResult = await shaExistsOnMainViaGitLsRemote(repoUrl, sha);
      if (lsResult === true) return "ok";
      return "infra_unavailable";
    }
    return result ? "ok" : "not_found";
  }

  // Non-GitHub repo: try git ls-remote
  const lsResult = await shaExistsOnMainViaGitLsRemote(repoUrl, sha);
  if (lsResult === true) return "ok";
  return lsResult === false ? "not_found" : "infra_unavailable";
}

// ---------------------------------------------------------------------------
// 422 error payloads
// ---------------------------------------------------------------------------

function makeRejectionPayload(reason: string, details: Record<string, unknown>) {
  return {
    error: "done_gate_rejected",
    reason,
    details,
    example: {
      "Path A (shippable)": [
        "verified_live_url: https://your-deploy-url.vercel.app",
        "verified_at: 2026-05-13T12:00:00.000Z",
        "verified_sha: <40-char git sha that exists on origin/main>",
      ].join("\n"),
      "Path B (non-shippable)": "non-shippable: audit",
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DoneGateParams {
  commentBody: string | null | undefined;
  issueId: string;
  projectId: string | null;
  companyId: string;
  db: Db;
}

export interface DoneGateRejection {
  error: string;
  reason: string;
  details: Record<string, unknown>;
  example: unknown;
}

/**
 * Returns a rejection payload if the close should be blocked, or null to allow.
 * In shadow mode always returns null (rejection is logged only).
 */
export async function validateDoneGate(params: DoneGateParams): Promise<DoneGateRejection | null> {
  const { commentBody, issueId, projectId, companyId, db } = params;

  // --- Resolve project repoUrl for SHA verification ---
  let repoUrl: string | null = null;
  if (projectId) {
    const workspace = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId))
      .then((rows) => rows.find((r) => r.repoUrl) ?? null);
    repoUrl = workspace?.repoUrl ?? null;
  }

  const body = commentBody ?? "";

  // --- Path C: placeholder ---
  const pathC = parsePathC(body);
  if (pathC) {
    const rejection = makeRejectionPayload("close_override_path_not_yet_enabled", {
      approvalId: pathC.approvalId,
      note: "Path C (close-override) is not yet enabled. Use Path A or Path B.",
    });
    if (DONE_GATE_SHADOW_MODE) {
      logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
      return null;
    }
    return rejection;
  }

  // --- Path B: non-shippable ---
  const pathB = parsePathB(body);
  if (pathB) {
    const raw = pathB.reason.toLowerCase();
    // Allow if reason starts with an allowlisted word (free-text qualifier permitted after)
    const allowed = Array.from(PATH_B_ALLOWLIST).some((term) => raw === term || raw.startsWith(term + " ") || raw.startsWith(term + ":") || raw.startsWith(term + ","));
    if (!allowed) {
      const rejection = makeRejectionPayload("path_b_reason_not_allowed", {
        reason: pathB.reason,
        allowed: Array.from(PATH_B_ALLOWLIST),
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }
    // Valid Path B
    logger.info({ issueId, companyId, path: "B", reason: pathB.reason }, "done-gate: accepted via Path B");
    return null;
  }

  // --- Path A: shippable ---
  const pathA = parsePathA(body);
  if (pathA) {
    // Validate verified_live_url
    if (!pathA.verifiedLiveUrl || !pathA.verifiedLiveUrl.startsWith("https://")) {
      const rejection = makeRejectionPayload("path_a_invalid_live_url", {
        verifiedLiveUrl: pathA.verifiedLiveUrl,
        note: "verified_live_url must be a https:// URL",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }

    // Validate verified_at
    if (!pathA.verifiedAt) {
      const rejection = makeRejectionPayload("path_a_missing_verified_at", {
        note: "verified_at is required (ISO-8601 timestamp within 60 min of now)",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }
    const verifiedAtMs = new Date(pathA.verifiedAt).getTime();
    if (Number.isNaN(verifiedAtMs)) {
      const rejection = makeRejectionPayload("path_a_invalid_verified_at", {
        verifiedAt: pathA.verifiedAt,
        note: "verified_at must be a valid ISO-8601 timestamp",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }
    const ageMs = Date.now() - verifiedAtMs;
    if (ageMs > VERIFIED_AT_MAX_AGE_MS || ageMs < -5 * 60 * 1000) {
      const rejection = makeRejectionPayload("path_a_verified_at_too_old", {
        verifiedAt: pathA.verifiedAt,
        ageMinutes: Math.round(ageMs / 60_000),
        maxAgeMinutes: 60,
        note: "verified_at must be within the last 60 minutes",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }

    // Validate verified_sha
    if (!pathA.verifiedSha) {
      const rejection = makeRejectionPayload("path_a_missing_verified_sha", {
        note: "verified_sha is required (40-char hex git SHA that exists on origin/main)",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }
    if (!/^[0-9a-f]{40}$/.test(pathA.verifiedSha)) {
      const rejection = makeRejectionPayload("path_a_invalid_verified_sha_format", {
        verifiedSha: pathA.verifiedSha,
        note: "verified_sha must be exactly 40 lowercase hex characters",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }

    // SHA existence check
    const shaResult = await verifySha(pathA.verifiedSha, repoUrl);
    if (shaResult === "not_found") {
      const rejection = makeRejectionPayload("path_a_sha_not_found", {
        verifiedSha: `${pathA.verifiedSha} → 404`,
        note: "verified_sha does not exist on origin/main",
      });
      if (DONE_GATE_SHADOW_MODE) {
        logger.warn({ issueId, companyId, reason: rejection.reason, sha: pathA.verifiedSha }, "done-gate shadow: would reject");
        return null;
      }
      return rejection;
    }
    if (shaResult === "infra_unavailable") {
      logger.warn(
        { issueId, companyId, sha: pathA.verifiedSha, repoUrl },
        "done-gate: SHA verification unavailable (no repoUrl or infra error) — passing in shadow mode",
      );
      if (!DONE_GATE_SHADOW_MODE) {
        // Hard enforcement: fail closed when infra is unavailable
        const rejection = makeRejectionPayload("path_a_sha_infra_unavailable", {
          verifiedSha: `${pathA.verifiedSha} → infra_unavailable`,
          note: "SHA verification infrastructure unavailable. Park the close and retry, or contact platform support.",
        });
        return rejection;
      }
      return null;
    }

    // Valid Path A
    logger.info(
      { issueId, companyId, path: "A", sha: pathA.verifiedSha, url: pathA.verifiedLiveUrl },
      "done-gate: accepted via Path A",
    );
    return null;
  }

  // --- No valid path found ---
  const rejection = makeRejectionPayload("missing_close_block", {
    note: "A status=done PATCH requires a valid close block in the comment. Include Path A (verified_live_url / verified_at / verified_sha) for shippable work or Path B (non-shippable: <reason>) for non-shippable work.",
  });
  if (DONE_GATE_SHADOW_MODE) {
    logger.warn({ issueId, companyId, reason: rejection.reason }, "done-gate shadow: would reject");
    return null;
  }
  return rejection;
}
