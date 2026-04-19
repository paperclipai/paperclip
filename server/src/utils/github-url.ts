/**
 * Shared GitHub URL utilities.
 *
 * Consolidates the duplicated GitHub URL parsing logic previously inlined in
 * github.ts, company-skills.ts, and company-portability.ts.
 *
 * All functions are pure (no DB, no service dependencies) so they can be
 * imported freely from any server module.
 */

import path from "node:path";
import { unprocessable } from "../errors.js";

// ---------------------------------------------------------------------------
// Basic owner/repo extraction
// ---------------------------------------------------------------------------

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Parse owner/repo from a GitHub URL (HTTPS or SSH).
 *
 * Returns `null` when the URL does not match any known GitHub format.
 */
export function parseGitHubRepoUrl(repoUrl: string): GitHubRepo | null {
  const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };

  const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

  return null;
}

/**
 * Returns `true` when the value looks like a valid GitHub repository URL
 * (HTTPS only). Useful for lightweight client-side validation.
 */
export function isGitHubRepoUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Rich GitHub URL parsing (tree / blob / query params)
// ---------------------------------------------------------------------------

export interface ParsedGitHubSourceUrl {
  owner: string;
  repo: string;
  ref: string;
  basePath: string;
}

export interface ParsedGitHubSkillUrl extends ParsedGitHubSourceUrl {
  filePath: string | null;
  explicitRef: boolean;
}

export interface ParsedGitHubCompanyUrl extends ParsedGitHubSourceUrl {
  companyPath: string;
}

function normalizeSourcePath(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Parse a GitHub URL into components for skill imports.
 *
 * Handles `/tree/<ref>/...` and `/blob/<ref>/...` path conventions.
 * Throws `unprocessable` for non-GitHub URLs or invalid paths.
 */
export function parseGitHubSkillUrl(rawUrl: string): ParsedGitHubSkillUrl {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;

  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
    explicitRef = true;
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    filePath = parts.slice(4).join("/");
    basePath = filePath ? path.posix.dirname(filePath) : "";
    explicitRef = true;
  }

  return { owner, repo, ref, basePath, filePath, explicitRef };
}

/**
 * Parse a GitHub URL into components for company imports.
 *
 * Supports `?ref=`, `?path=`, and `?companyPath=` query parameters in
 * addition to the standard `/tree/` and `/blob/` path conventions.
 * Throws `unprocessable` for non-GitHub URLs or invalid paths.
 */
export function parseGitHubCompanyUrl(rawUrl: string): ParsedGitHubCompanyUrl {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");

  const queryRef = url.searchParams.get("ref")?.trim();
  const queryPath = normalizeSourcePath(url.searchParams.get("path"));
  const queryCompanyPath = normalizeSourcePath(url.searchParams.get("companyPath"));

  if (queryRef || queryPath || queryCompanyPath) {
    const companyPath = queryCompanyPath || [queryPath, "COMPANY.md"].filter(Boolean).join("/") || "COMPANY.md";
    let basePath = queryPath;
    if (!basePath && companyPath !== "COMPANY.md") {
      basePath = path.posix.dirname(companyPath);
      if (basePath === ".") basePath = "";
    }
    return { owner, repo, ref: queryRef || "main", basePath, companyPath };
  }

  let ref = "main";
  let basePath = "";
  let companyPath = "COMPANY.md";

  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath;
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }

  return { owner, repo, ref, basePath, companyPath };
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------

/**
 * Build a raw.githubusercontent.com URL for fetching file content directly.
 */
export function buildRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string): string {
  const normalized = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalized}`;
}
