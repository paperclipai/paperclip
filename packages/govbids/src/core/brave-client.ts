/**
 * Brave Search API client (https://api.search.brave.com).
 *
 * Used by discovery to replicate a human's "<town> <state> bids RFP" Google
 * search, returning candidate procurement-page URLs to fetch + extract.
 * Requires BRAVE_API_KEY (free tier: 1 query/sec, 2,000/month; paid ~$3-5/1k).
 */
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export interface BraveResult {
  title: string;
  url: string;
  description: string;
}

export interface BraveClientOptions {
  apiKey: string;
  /** Min ms between calls (free tier = 1 req/sec). */
  rateLimitMs?: number;
}

export class BraveClient {
  private lastCall = 0;
  constructor(private opts: BraveClientOptions) {}

  private async throttle(): Promise<void> {
    const wait = (this.opts.rateLimitMs ?? 1100) - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  async search(query: string, count = 5): Promise<BraveResult[]> {
    await this.throttle();
    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(count));
    url.searchParams.set("country", "us");
    url.searchParams.set("safesearch", "off");

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": this.opts.apiKey,
      },
    });
    if (!res.ok) {
      throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> };
    };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
    }));
  }
}

/**
 * Candidate procurement-page URLs look like bid/RFP/procurement portals.
 * Filters Brave results to the ones worth fetching+extracting.
 */
export function looksLikeProcurementUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    /\b(bid|bids|rfp|rfq|procurement|purchasing|solicitation|eprocurement|opportunit)/.test(u) ||
    /(demandstar|bidnetdirect|ionwave|opengov|bonfirehub|publicpurchase|civicengage|civicplus)\.com/.test(u) ||
    /\.gov\b/.test(u)
  );
}
