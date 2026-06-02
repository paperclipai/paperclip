/**
 * Free keyword research helpers — ported from agnb lib/agnb/keyword-research.ts.
 * No API keys required. Scrapes Google Autocomplete's public suggest endpoint.
 */

const SUGGEST_URL = "https://suggestqueries.google.com/complete/search";
const TIMEOUT = 8_000;

/** One-shot suggest. Returns up to 10 suggestions for a query. */
export async function googleSuggest(query: string, signal?: AbortSignal): Promise<string[]> {
  if (!query.trim()) return [];
  const params = new URLSearchParams({ client: "firefox", q: query, hl: "en" });
  try {
    const r = await fetch(`${SUGGEST_URL}?${params}`, {
      headers: { "user-agent": "Mozilla/5.0 FinnBot/1.0" },
      signal: signal ?? AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) return [];
    const text = await r.text();
    // Firefox client returns: ["query", ["sug1", "sug2", ...]]
    const j = JSON.parse(text);
    if (!Array.isArray(j) || !Array.isArray(j[1])) return [];
    return (j[1] as string[]).filter((s) => typeof s === "string" && s.trim().length > 0).slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Expanded suggest: base query + "<query> a", "<query> b" ... to harvest
 * long-tail variations. Returns unique deduped list. ~1 req/sec.
 */
export async function googleSuggestExpand(query: string, letters = 6): Promise<string[]> {
  const all = new Set<string>();
  for (const s of await googleSuggest(query)) all.add(s);
  await sleep(1_000);
  const alphabet = "abcdefghij".slice(0, letters);
  for (const ch of alphabet) {
    for (const s of await googleSuggest(`${query} ${ch}`)) all.add(s);
    await sleep(1_000);
  }
  return Array.from(all);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
