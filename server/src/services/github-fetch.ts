import { unprocessable } from "../errors.js";

export function isGitHubDotCom(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

export function isGitHubHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    isGitHubDotCom(h) ||
    h === "api.github.com" ||
    h === "raw.githubusercontent.com"
  );
}

export function gitHubApiBase(hostname: string): string {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string): string {
  const p = filePath.replace(/^\/+/, "");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export function getGitHubTokenForHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (isGitHubHost(h)) {
    const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
    if (token) return token;
  }
  const enterpriseHost = process.env.GITHUB_ENTERPRISE_HOST?.trim().toLowerCase() || process.env.GH_HOST?.trim().toLowerCase();
  if (enterpriseHost && h === enterpriseHost) {
    const enterpriseToken =
      process.env.GITHUB_ENTERPRISE_TOKEN?.trim() ||
      process.env.GH_ENTERPRISE_TOKEN?.trim() ||
      process.env.GITHUB_TOKEN?.trim() ||
      process.env.GH_TOKEN?.trim();
    if (enterpriseToken) return enterpriseToken;
  }
  return null;
}

function hasAuthorizationHeader(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.has("authorization");
  }
  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === "authorization");
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function injectAuthorizationHeader(headers: HeadersInit | undefined, token: string): HeadersInit {
  if (!headers) {
    return { authorization: `Bearer ${token}` };
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const cloned = new Headers(headers);
    cloned.set("authorization", `Bearer ${token}`);
    return cloned;
  }
  if (Array.isArray(headers)) {
    return [...headers, ["authorization", `Bearer ${token}`]];
  }
  return {
    ...headers,
    authorization: `Bearer ${token}`,
  };
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  let effectiveInit = init;
  try {
    const hostname = new URL(url).hostname;
    const token = getGitHubTokenForHost(hostname);
    if (token && !hasAuthorizationHeader(init?.headers)) {
      effectiveInit = {
        ...init,
        headers: injectAuthorizationHeader(init?.headers, token),
      };
    }
  } catch {
    // Ignore URL parse error here; fetch will handle invalid URLs
  }

  try {
    return await fetch(url, effectiveInit);
  } catch {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      hostname = url;
    }
    throw unprocessable(`Could not connect to ${hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
