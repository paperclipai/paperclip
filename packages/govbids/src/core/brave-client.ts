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
    // Free tier is strict (~1 req/sec); 1.5s leaves headroom to avoid 429s.
    const wait = (this.opts.rateLimitMs ?? 1500) - (Date.now() - this.lastCall);
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
 * Domains to NEVER fetch from discovery: third-party aggregators (which the 3
 * main sources already cover — fetching them double-sources + adds noise) and
 * big state-level IT portals that leak into small-town queries (e.g. NY ITS
 * showing up for an Idaho-town search). Discovery's whole point is the OWN-site
 * long tail these miss.
 */
const DISCOVERY_BLOCKLIST = [
  "findrfp.com", "rfpmart.com", "bidnetdirect.com", "govdirections.com",
  "uspublicworks.com", "texasbids.net", "idahobids.com", "southcarolinabids.com",
  "highergov.com", "bidprime.com", "govtribe.com", "bidsync.com",
  // big state-level portals (aggregator-equivalent for our purposes)
  "its.ny.gov", "ogs.ny.gov", "in.gov", "tn.gov", "ri.gov", "idaho.gov",
  "purchasing.idaho.gov", "ms.gov", "ca.gov", "texas.gov",
];

export function isBlockedDiscoveryDomain(url: string): boolean {
  const u = url.toLowerCase();
  if (DISCOVERY_BLOCKLIST.some((d) => u.includes(d))) return true;
  // any *.state.*.us or generic statewide portal
  if (/\.state\.[a-z]{2}\.us/.test(u)) return true;
  return false;
}

/**
 * Candidate procurement-page URLs look like bid/RFP/procurement portals AND are
 * not on the aggregator/big-portal blocklist.
 */
export function looksLikeProcurementUrl(url: string): boolean {
  if (isBlockedDiscoveryDomain(url)) return false;
  const u = url.toLowerCase();
  return (
    /\b(bid|bids|rfp|rfq|procurement|purchasing|solicitation|eprocurement|opportunit)/.test(u) ||
    /(demandstar|ionwave|opengov|bonfirehub|publicpurchase|civicengage|civicplus)\.com/.test(u) ||
    /\.gov\b/.test(u)
  );
}

/**
 * Does this URL's host plausibly belong to the target town/org? Fixes the
 * state-misattribution bug — a result from another jurisdiction's portal must
 * not be tagged with the target town's state. We require a significant token of
 * the town name (or the org's portal tenant slug) to appear in the host/path.
 */
export function urlBelongsToTarget(url: string, townName: string): boolean {
  const host = url.toLowerCase();
  const tokens = townName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter((t) => t.length >= 4); // skip short words like "fort", "city"
  if (tokens.length === 0) {
    // very short town names — require the longest word ≥3 chars
    const t = townName.toLowerCase().replace(/[^a-z0-9]/g, "");
    return t.length >= 3 && host.includes(t);
  }
  return tokens.some((t) => host.includes(t));
}
