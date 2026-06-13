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
 * Recognizes URLs that target GitHub or an explicitly-configured GitHub
 * Enterprise instance. Matching is hostname-only — github.com properties are
 * built in; GHE hosts must be opted in via the `PAPERCLIP_GITHUB_HOSTS` env
 * var (comma-separated). Path-based detection is intentionally avoided so a
 * URL like `https://attacker.example.com/api/v3/collect` cannot trick
 * {@link authHeadersForGitHub} into attaching a token.
 */
function looksLikeGitHubUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "www.github.com") return true;
  if (host === "api.github.com") return true;
  if (host === "raw.githubusercontent.com" || host === "codeload.github.com") return true;
  if (host.endsWith(".github.com")) return true;
  const enterpriseHosts = process.env.PAPERCLIP_GITHUB_HOSTS;
  if (enterpriseHosts) {
    const allowlist = enterpriseHosts
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    if (allowlist.includes(host)) return true;
  }
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
