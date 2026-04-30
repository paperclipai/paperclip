import { unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

/**
 * Recognizes URLs that look like they target GitHub or a GitHub Enterprise
 * instance. github.com properties are matched by hostname; GHE installs are
 * detected by the URL shape produced by {@link gitHubApiBase} (paths under
 * `/api/v3`) and {@link resolveRawGitHubUrl} (paths under `/raw`). Anything
 * else is treated as a non-GitHub URL — even if a caller mistakenly passes
 * one to {@link ghFetch}, no credentials will be attached to it.
 */
function looksLikeGitHubUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") return true;
  if (host === "api.github.com") return true;
  if (host === "raw.githubusercontent.com" || host === "codeload.github.com") return true;
  if (host.endsWith(".github.com")) return true;
  // GitHub Enterprise: gitHubApiBase / resolveRawGitHubUrl emit /api/v3 and /raw paths.
  const path = url.pathname;
  if (path === "/api/v3" || path.startsWith("/api/v3/")) return true;
  if (path === "/raw" || path.startsWith("/raw/")) return true;
  return false;
}

/**
 * Attaches `Authorization: Bearer ${GITHUB_TOKEN}` (with `GH_TOKEN` as fallback)
 * to outgoing requests when a token is set in the environment AND the URL is
 * recognized by {@link looksLikeGitHubUrl}. Caller-supplied `Authorization`
 * headers always win.
 */
function authHeadersForGitHub(url: string, init?: RequestInit): RequestInit | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return init;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return init;
  }
  if (!looksLikeGitHubUrl(parsed)) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return { ...(init ?? {}), headers };
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, authHeadersForGitHub(url, init));
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
