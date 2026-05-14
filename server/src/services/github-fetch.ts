import { unprocessable } from "../errors.js";

export type GitHostFamily = "github" | "gitea";

export function inferGitHostFamily(hostname: string): GitHostFamily {
  const h = hostname.toLowerCase();
  if (h === "github.com" || h === "www.github.com") return "github";
  return "gitea";
}

export function gitHubApiBase(hostname: string) {
  return inferGitHostFamily(hostname) === "github"
    ? "https://api.github.com"
    : `https://${hostname}/api/v1`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "");
  if (inferGitHostFamily(hostname) === "github") {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`;
  }
  return `https://${hostname}/api/v1/repos/${owner}/${repo}/media/${p}?ref=${encodeURIComponent(ref)}`;
}

export async function ghFetch(url: string, init?: RequestInit, authToken?: string): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  try {
    return await fetch(url, { ...init, headers, redirect: authToken ? "manual" : "follow" });
  } catch {
    const hostname = (() => {
      try { return new URL(url).hostname; } catch { return url; }
    })();
    throw unprocessable(`Could not connect to ${hostname}`);
  }
}
