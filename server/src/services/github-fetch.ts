import { unprocessable } from "../errors.js";
import { getGitHubAppInstallationToken } from "./github-app.js";
import { getGitHubUserToken } from "./github-user-token.js";

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

const GITHUB_AUTH_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
]);

/**
 * Resolve a GitHub credential for an outbound fetch.
 *
 * 1. User OAuth token — covers any repo the authenticated user can see
 * 2. GitHub App installation token — covers repos where the app is installed
 *    (zero-config for the lucitra org, survives server restarts)
 */
async function resolveGitHubCredential(): Promise<string | null> {
  const userToken = getGitHubUserToken();
  if (userToken) return userToken;

  const installationToken = await getGitHubAppInstallationToken();
  if (installationToken) return installationToken;

  return null;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw unprocessable(`Invalid GitHub URL: ${url}`);
  }

  const headers = new Headers(init?.headers);
  const hostname = parsed.hostname.toLowerCase();
  const isGitHubHost =
    GITHUB_AUTH_HOSTS.has(hostname) || hostname.endsWith(".githubusercontent.com");
  if (isGitHubHost && !headers.has("authorization")) {
    const token = await resolveGitHubCredential();
    if (token) {
      headers.set("authorization", `token ${token}`);
    }
  }

  try {
    return await fetch(url, { ...init, headers });
  } catch {
    throw unprocessable(
      `Could not connect to ${parsed.hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`,
    );
  }
}
