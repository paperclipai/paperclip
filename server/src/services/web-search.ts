/**
 * Web search service backed by a SearXNG instance.
 *
 * Behavior:
 * - If SearXNG is reachable, returns up to `maxResults` results.
 * - If SearXNG is unreachable or returns an error, logs a warning and returns
 *   an empty array. Agents must not fail because search is unavailable.
 */

import { logger } from "../middleware/logger.js";

const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://100.90.180.107:8888";
const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

interface SearxngResultItem {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  engines?: unknown[];
}

function toSearchResult(item: SearxngResultItem): SearchResult | null {
  if (typeof item.url !== "string") return null;
  return {
    title: typeof item.title === "string" ? item.title : item.url,
    url: item.url,
    content: typeof item.content === "string" ? item.content : "",
    engine:
      typeof item.engine === "string"
        ? item.engine
        : Array.isArray(item.engines) && typeof item.engines[0] === "string"
          ? (item.engines[0] as string)
          : "searxng",
  };
}

/**
 * Run a web search via SearXNG.
 *
 * @param query - The search query string.
 * @param maxResults - Maximum number of results to return (default 5).
 * @returns Array of SearchResult objects, empty if search fails.
 */
export async function webSearch(
  query: string,
  maxResults: number = DEFAULT_MAX_RESULTS,
): Promise<SearchResult[]> {
  if (!query || !query.trim()) return [];

  const url = new URL("/search", SEARXNG_URL);
  url.searchParams.set("q", query.trim());
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      logger.warn(
        { status: response.status, query },
        "[web-search] SearXNG returned non-OK status",
      );
      return [];
    }

    const payload = (await response.json()) as { results?: SearxngResultItem[] };
    const rawResults: SearxngResultItem[] = Array.isArray(payload.results)
      ? payload.results
      : [];

    const results: SearchResult[] = [];
    for (const item of rawResults) {
      if (results.length >= maxResults) break;
      const parsed = toSearchResult(item);
      if (parsed) results.push(parsed);
    }

    logger.debug(
      { query, resultCount: results.length, maxResults },
      "[web-search] search completed",
    );

    return results;
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === "AbortError";
    logger.warn(
      { err: isAbort ? "timeout" : err, query, searxngUrl: SEARXNG_URL },
      "[web-search] SearXNG unreachable or timed out - returning empty results",
    );
    return [];
  }
}

/**
 * Returns true when the given text appears to be requesting web research.
 */
export const RESEARCH_KEYWORDS = [
  "research",
  "look up",
  "find out",
  "search for",
  "investigate",
  "what is the current",
  "latest",
  "compare",
  "analyze market",
  "competitor",
] as const;

export function isResearchTask(text: string): boolean {
  const lower = text.toLowerCase();
  return RESEARCH_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Extract a clean search query from an issue title.
 * Strips imperative prefixes like "Research ...", "Look up ...", etc.
 */
export function extractSearchQuery(title: string): string {
  const prefixes = [
    /^research\s+/i,
    /^look\s+up\s+/i,
    /^find\s+out\s+/i,
    /^search\s+for\s+/i,
    /^investigate\s+/i,
    /^compare\s+/i,
  ];
  let q = title.trim();
  for (const re of prefixes) {
    q = q.replace(re, "");
  }
  return q.trim() || title.trim();
}
