import { escapeHtml } from "../lib/html.ts";
import type { QueryResult } from "../types.ts";

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function getTavilyKey(): string {
  return Deno.env.get("TAVILY_API_KEY") ?? "";
}

function getSerpapiKey(): string {
  return Deno.env.get("SERPAPI_API_KEY") ?? "";
}

async function searchTavily(query: string): Promise<SearchResult[]> {
  const apiKey = getTavilyKey();
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      max_results: 5,
    }),
  });
  if (!res.ok) throw new Error(`Tavily API returned ${res.status}`);
  const data = await res.json();
  const results = data.results ?? [];
  return results.map((r: { title?: string; url?: string; content?: string }) => ({
    title: r.title ?? "Untitled",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function searchSerpApi(query: string): Promise<SearchResult[]> {
  const apiKey = getSerpapiKey();
  const url = `https://serpapi.com/search?q=${encodeURIComponent(query)}&api_key=${apiKey}&num=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SerpAPI returned ${res.status}`);
  const data = await res.json();
  const results = data.organic_results ?? [];
  return results.map((r: { title?: string; link?: string; snippet?: string }) => ({
    title: r.title ?? "Untitled",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DuckDuckGo API returned ${res.status}`);
  const data = await res.json();
  const results: SearchResult[] = [];

  if (data.AbstractText) {
    results.push({
      title: data.AbstractSource || "Result",
      url: data.AbstractURL || "",
      snippet: data.AbstractText,
    });
  }

  const topics = data.RelatedTopics ?? [];
  for (const topic of topics) {
    if (topic.Name && topic.Topics) {
      for (const sub of topic.Topics) {
        if (sub.Text) {
          results.push({
            title: sub.FirstURL?.split("/").pop()?.replace(/_/g, " ") ?? "Result",
            url: sub.FirstURL ?? "",
            snippet: sub.Text,
          });
        }
        if (results.length >= 5) break;
      }
    } else if (topic.Text) {
      results.push({
        title: topic.FirstURL?.split("/").pop()?.replace(/_/g, " ") ?? "Result",
        url: topic.FirstURL ?? "",
        snippet: topic.Text,
      });
    }
    if (results.length >= 5) break;
  }

  return results;
}

export async function handleWebSearch(query: string): Promise<QueryResult> {
  try {
    let results: SearchResult[];
    const tavilyKey = getTavilyKey();
    const serpapiKey = getSerpapiKey();

    if (tavilyKey) {
      results = await searchTavily(query);
    } else if (serpapiKey) {
      results = await searchSerpApi(query);
    } else {
      results = await searchDuckDuckGo(query);
    }

    if (results.length === 0) {
      return {
        text: `No search results found for <b>${escapeHtml(query)}</b>. Try a different query.`,
      };
    }

    const lines = [
      `<b>Search results for: ${escapeHtml(query)}</b>`,
      "",
      ...results.map(
        (r, i) =>
          `${i + 1}. <b>${escapeHtml(r.title)}</b>\n   ${escapeHtml(r.snippet)}${r.url ? `\n   <a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a>` : ""}`,
      ),
      "",
      `<i>Powered by ${tavilyKey ? "Tavily" : serpapiKey ? "SerpAPI" : "DuckDuckGo"}. Results may not be comprehensive.</i>`,
    ];

    return { text: lines.join("\n") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Web search failed: ${message}`);
    return {
      text: `Web search is currently unavailable. Error: ${escapeHtml(message)}`,
    };
  }
}

export function isWebSearchConfigured(): boolean {
  return !!(getTavilyKey() || getSerpapiKey());
}
