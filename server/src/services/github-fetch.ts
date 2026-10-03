import { unprocessable } from "../errors.js";

export function isGitHubDotCom(hostname: string) {
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
 * Environment variables a GitHub token may be supplied in. These mirror
 * DEFAULT_GITHUB_TOKEN_SECRET_NAMES in git-credentials.ts, so an operator who has
 * already set a token for git operations does not learn a second convention.
 */
const GITHUB_TOKEN_ENV_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

/**
 * Hosts the token may be sent to. GitHub Enterprise hostnames are arbitrary
 * strings taken from an operator-supplied import URL, so they are excluded: a
 * token configured for github.com must never travel to a host named in a URL.
 */
const GITHUB_AUTH_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

function readGitHubToken(): string | null {
  for (const key of GITHUB_TOKEN_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Add a Bearer token to a github.com request when one is configured.
 *
 * Anonymous GitHub API access is 60 requests per hour per IP, shared by the whole
 * instance. A single skill import costs two to three of them, so importing a few
 * skills exhausts the hour for every other GitHub-backed feature. Authenticated
 * access is 5,000 per hour, per token.
 *
 * Returns `init` unchanged when there is no token, when the host is not a
 * github.com host, or when the caller already set an Authorization header.
 */
function withGitHubAuth(url: string, init?: RequestInit): RequestInit | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return init;
  }
  if (!GITHUB_AUTH_HOSTS.has(hostname)) return init;

  const headers = new Headers(init?.headers);
  if (headers.has("authorization")) return init;

  const token = readGitHubToken();
  if (!token) return init;

  headers.set("authorization", `Bearer ${token}`);
  return { ...(init ?? {}), headers };
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, withGitHubAuth(url, init));
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
