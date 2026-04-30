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
 * Attaches `Authorization: Bearer ${GITHUB_TOKEN}` (with `GH_TOKEN` as fallback)
 * to outgoing requests when a token is set in the environment.
 *
 * `ghFetch` is the GitHub-specific fetch helper for this module: every URL
 * passed in originates from `gitHubApiBase()` or `resolveRawGitHubUrl()`,
 * which produce either `api.github.com` / `raw.githubusercontent.com` (for
 * github.com) or `https://<host>/api/v3` / `https://<host>/raw/...` (for
 * GitHub Enterprise). We therefore attach the token unconditionally rather
 * than gating on a github.com allowlist that would silently skip GHE.
 * Caller-supplied `Authorization` headers always win.
 */
function authHeadersForGitHub(url: string, init?: RequestInit): RequestInit | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return init;
  try {
    new URL(url);
  } catch {
    return init;
  }
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
