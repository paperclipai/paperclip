import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
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

const GITHUB_DOT_COM_FETCH_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

// The server token can read whatever it can read on GitHub, so only instance admins get it:
// other callers (and background work outside a request) fetch anonymously.
const serverGitHubTokenAllowed = new AsyncLocalStorage<boolean>();

export function runWithServerGitHubToken<T>(allowed: boolean, fn: () => T): T {
  return serverGitHubTokenAllowed.run(allowed, fn);
}

export const serverGitHubTokenMiddleware: RequestHandler = (req, _res, next) =>
  runWithServerGitHubToken(req.actor?.isInstanceAdmin === true, next);

// Server env token (the same fallback as git-credentials), so imports do not share the anonymous 60/hour limit.
function withGitHubToken(url: string, init?: RequestInit): RequestInit | undefined {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token || serverGitHubTokenAllowed.getStore() !== true) return init;
  const target = new URL(url);
  if (target.protocol !== "https:" || !GITHUB_DOT_COM_FETCH_HOSTS.has(target.hostname)) return init;
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, withGitHubToken(url, init));
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
