import { unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export type GitHostType = "github" | "ghe" | "gitea";

// Simple in-memory cache — avoids a probe on every raw-file fetch within a request.
const gitTypeCache = new Map<string, GitHostType>();

/**
 * Detects whether a self-hosted git host is Gitea or GitHub Enterprise by
 * probing the Gitea-specific /api/v1/version endpoint. GitHub Enterprise does
 * not expose this endpoint; Gitea always does.
 *
 * Result is cached per hostname for the lifetime of the process so the probe
 * is only ever issued once per host.
 */
export async function detectGitType(hostname: string): Promise<GitHostType> {
  if (isGitHubDotCom(hostname)) return "github";
  const cached = gitTypeCache.get(hostname);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://${hostname}/api/v1/version`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    const type: GitHostType = res.ok ? "gitea" : "ghe";
    gitTypeCache.set(hostname, type);
    return type;
  } catch {
    gitTypeCache.set(hostname, "ghe");
    return "ghe";
  }
}

export function resolveRawGitHubUrl(
  hostname: string,
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
  gitType: GitHostType = "ghe",
) {
  const p = filePath.replace(/^\/+/, "");
  if (isGitHubDotCom(hostname) || gitType === "github") {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`;
  }
  if (gitType === "gitea") {
    // Gitea raw file URL format: /{owner}/{repo}/raw/branch/{ref}/{path}
    return `https://${hostname}/${owner}/${repo}/raw/branch/${ref}/${p}`;
  }
  // GitHub Enterprise
  return `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
