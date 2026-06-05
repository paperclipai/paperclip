/**
 * Minimal SerpAPI client (https://serpapi.com). Used to pull review-platform
 * aggregate ratings (G2/Trustpilot/Capterra/Product Hunt) past the bot-walls
 * that block a raw fetch, using the existing SERPAPI_KEY — no extra account.
 * Best-effort: SerpAPI surfaces SaaS-review ratings via Google's knowledge graph
 * / rich snippets, which is reliable for some sources and spotty for others.
 */
const BASE = "https://serpapi.com/search.json";

export function serpapiConfigured(): boolean {
  return !!process.env.SERPAPI_KEY;
}

export interface SerpRating {
  rating: number | null;
  reviews: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function googleSearch(q: string): Promise<Record<string, unknown>> {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY missing");
  const url = `${BASE}?engine=google&num=10&q=${encodeURIComponent(q)}&api_key=${key}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`serpapi http ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()) as Record<string, unknown>;
}

/**
 * Best-effort aggregate rating for `brand` on a review platform. Checks the
 * knowledge graph first, then organic rich snippets whose link is on the
 * platform domain, then any organic rich snippet.
 */
export async function platformRating(brand: string, platform: string, domain: string): Promise<SerpRating> {
  const data = await googleSearch(`${brand} ${platform} reviews`);

  const kg = data.knowledge_graph as Record<string, unknown> | undefined;
  if (kg && kg.rating != null) {
    return { rating: num(kg.rating), reviews: num(kg.reviews ?? kg.review_count ?? kg.user_ratings) };
  }

  const organic = (Array.isArray(data.organic_results) ? data.organic_results : []) as Array<Record<string, unknown>>;
  const ratingFrom = (o: Record<string, unknown>): SerpRating | null => {
    const rs = o.rich_snippet as Record<string, unknown> | undefined;
    const ext =
      ((rs?.top as Record<string, unknown> | undefined)?.detected_extensions as Record<string, unknown> | undefined) ??
      ((rs?.bottom as Record<string, unknown> | undefined)?.detected_extensions as Record<string, unknown> | undefined);
    if (ext && ext.rating != null) return { rating: num(ext.rating), reviews: num(ext.reviews ?? ext.votes) };
    return null;
  };

  for (const o of organic) {
    const link = String(o.link ?? "");
    if (domain && !link.includes(domain)) continue;
    const r = ratingFrom(o);
    if (r?.rating != null) return r;
  }
  for (const o of organic) {
    const r = ratingFrom(o);
    if (r?.rating != null) return r;
  }
  return { rating: null, reviews: null };
}
