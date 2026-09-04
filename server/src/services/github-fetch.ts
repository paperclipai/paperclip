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

function githubApiToken(url: string) {
  if (new URL(url).hostname.toLowerCase() !== "api.github.com") return null;
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || null;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const token = githubApiToken(url);
    if (!token) return await fetch(url, init);

    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return await fetch(url, { ...init, headers });
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
