/**
 * Free backlink prospecting helpers — no paid APIs.
 *
 * Ported verbatim from the AGNB app (lib/agnb/backlink-discovery.ts). Pure
 * fetch — no DB, no supabase.
 *
 * Sources:
 *   - Common Crawl CDX index: finds pages that contain references to a URL.
 *   - Gemini: given competitor + topic, returns candidate referring domains.
 *     Requires GEMINI_API_KEY (returns [] if absent).
 *   - OpenPageRank: free 1k requests/day, returns 0-10 domain rank.
 *     Requires OPENPAGERANK_API_KEY (returns {} if absent).
 */

const CDX_INDEX = "https://index.commoncrawl.org";
const OPR_API = "https://openpagerank.com/api/v1.0/getPageRank";

/** List available Common Crawl indexes (we use the latest). */
async function getLatestCCIndex(): Promise<string | null> {
  try {
    const r = await fetch("https://index.commoncrawl.org/collinfo.json", { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const collections = (await r.json()) as Array<{ id: string; "cdx-api": string }>;
    return collections[0]?.id ?? null; // first = latest
  } catch {
    return null;
  }
}

/**
 * Query Common Crawl for URLs that match a pattern. Returns up to `limit`
 * matching URLs (entries from CDX).
 */
export async function ccLookup(
  urlPattern: string,
  limit = 100,
): Promise<Array<{ url: string; timestamp: string; status: string }>> {
  const idx = await getLatestCCIndex();
  if (!idx) return [];
  try {
    const params = new URLSearchParams({
      url: urlPattern,
      output: "json",
      limit: String(limit),
    });
    const r = await fetch(`${CDX_INDEX}/${idx}-index?${params}`, {
      headers: { "user-agent": "FinnBot/1.0 (+https://hirefinn.ai)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) return [];
    const body = await r.text();
    // CDX returns NDJSON
    return body
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ url: string; timestamp: string; status: string }>;
  } catch {
    return [];
  }
}

/** Gemini-driven prospect discovery — given competitor + topic, returns 10 candidate
 *  referring sites that likely cover this topic and could link to Finn. */
export async function geminiFindProspects(args: {
  competitor: string;
  topic: string;
  ourDomain: string;
}): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return [];
  const prompt = `List 10 real B2B publication / blog / community sites that frequently write about "${args.topic}" and would plausibly mention or link to a relevant resource on ${args.ourDomain}.

DO NOT include ${args.competitor} itself. DO NOT invent — only well-known publications you have strong evidence exist.

Mix:
- Industry publications (e.g. "techcrunch.com", "venturebeat.com")
- Newsletters (e.g. "lennysnewsletter.com")
- Forums / communities (e.g. "reddit.com/r/saas", "indiehackers.com")
- Round-up authors (e.g. specific listicle writers' blogs)

Return ONLY a JSON array of domains, no http://, no paths:
["techcrunch.com", "venturebeat.com", ...]`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 800,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = String(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string").slice(0, 10) : [];
  } catch {
    return [];
  }
}

/** OpenPageRank batch lookup. Free 1k/day. Returns map domain → rank (0-10). */
export async function openPageRank(domains: string[]): Promise<Record<string, number>> {
  const key = process.env.OPENPAGERANK_API_KEY;
  if (!key || domains.length === 0) return {};
  const out: Record<string, number> = {};
  // OPR limit: 100 domains per request
  for (let i = 0; i < domains.length; i += 100) {
    const batch = domains.slice(i, i + 100);
    const params = new URLSearchParams();
    for (const d of batch) params.append("domains[]", d);
    try {
      const r = await fetch(`${OPR_API}?${params}`, {
        headers: { "API-OPR": key },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as {
        response?: Array<{ domain: string; page_rank_integer: number; status_code: number }>;
      };
      for (const row of j.response ?? []) {
        if (row.status_code === 200) out[row.domain] = row.page_rank_integer;
      }
    } catch {
      /* skip batch */
    }
  }
  return out;
}
