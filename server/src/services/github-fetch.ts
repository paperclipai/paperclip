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

function authHeadersForGitHub(url: string, init?: RequestInit): RequestInit | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return init;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return init;
  }
  const isGitHubHost =
    host === "api.github.com" ||
    host === "github.com" ||
    host === "www.github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "codeload.github.com";
  if (!isGitHubHost) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization") && !headers.has("authorization")) {
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
