import { unprocessable } from "../errors.js";

export function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

/**
 * Returns true if the hostname is a known GitHub-operated domain where it is
 * safe to attach a Personal Access Token.  For GitHub Enterprise Server the
 * hostname is arbitrary, but those URLs are constructed from a previously-
 * validated source hostname via `gitHubApiBase` / `resolveRawGitHubUrl`, so
 * callers may pass `trustedGheHostname` to allowlist it explicitly.
 */
function isKnownGitHubHost(hostname: string, trustedGheHostname?: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === "github.com" ||
    h === "www.github.com" ||
    h === "api.github.com" ||
    h === "raw.githubusercontent.com"
  ) {
    return true;
  }
  if (trustedGheHostname && h === trustedGheHostname.toLowerCase()) {
    return true;
  }
  return false;
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

export async function ghFetch(
  url: string,
  init?: RequestInit,
  authToken?: string,
  trustedGheHostname?: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (authToken) {
    const { hostname } = new URL(url);
    if (isKnownGitHubHost(hostname, trustedGheHostname)) {
      headers.set("Authorization", `Bearer ${authToken}`);
    }
  }
  try {
    return await fetch(url, { ...init, headers, redirect: authToken ? "manual" : "follow" });
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
