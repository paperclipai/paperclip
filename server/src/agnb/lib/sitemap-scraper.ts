/**
 * Minimal sitemap.xml + blog page scraper for competitor intel.
 *
 * Ported verbatim from the AGNB app (lib/agnb/sitemap-scraper.ts). Pure fetch —
 * no DB, no supabase. No headless browser; regex-based extraction.
 *
 * - Handles sitemap index (recursive 1 level) + plain sitemap
 * - Filters URLs by path substring (e.g. "/blog/")
 * - Polite: 1 req/sec per domain, 8s timeout, identifies as Finn-bot
 * - Returns lightweight {url, title, description, excerpt, published_at}
 */

const USER_AGENT = "FinnBot/1.0 (+https://hirefinn.ai/bot)";
const REQUEST_TIMEOUT = 8_000;

export interface SitemapEntry {
  url: string;
  lastmod?: string; // ISO from sitemap, may be undefined
}

export interface ScrapedBlog {
  url: string;
  title: string | null;
  description: string | null;
  excerpt: string | null;
  published_at: string | null;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** Parse <loc> + optional <lastmod> from sitemap or sitemap-index XML. */
function parseSitemapXml(xml: string): { urls: SitemapEntry[]; isIndex: boolean } {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const blocks = xml.match(/<(?:url|sitemap)>[\s\S]*?<\/(?:url|sitemap)>/gi) ?? [];
  const urls: SitemapEntry[] = [];
  for (const b of blocks) {
    const loc = b.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (!loc) continue;
    const lastmod = b.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1];
    urls.push({ url: loc.trim(), lastmod: lastmod?.trim() });
  }
  return { urls, isIndex };
}

/**
 * Fetch sitemap, recurse 1 level on sitemap-index, return all URL entries.
 * Caps at 5,000 URLs to prevent runaway scrapes.
 */
export async function fetchSitemapEntries(sitemapUrl: string): Promise<SitemapEntry[]> {
  const xml = await fetchText(sitemapUrl);
  if (!xml) return [];

  const parsed = parseSitemapXml(xml);
  if (!parsed.isIndex) return parsed.urls;

  // sitemap-index → recurse, but cap to first 10 child sitemaps
  const childSitemaps = parsed.urls.slice(0, 10);
  const all: SitemapEntry[] = [];
  for (const child of childSitemaps) {
    if (all.length >= 5_000) break;
    const childXml = await fetchText(child.url);
    if (!childXml) continue;
    const childParsed = parseSitemapXml(childXml);
    all.push(...childParsed.urls);
    await sleep(1_000); // 1 req/sec polite
  }
  return all.slice(0, 5_000);
}

/** Filter sitemap entries by blog path substring + optional cutoff date. */
export function filterBlogUrls(entries: SitemapEntry[], pathPattern: string, sinceIso?: string): SitemapEntry[] {
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  return entries.filter((e) => {
    if (!e.url.includes(pathPattern)) return false;
    if (since > 0 && e.lastmod) {
      const t = new Date(e.lastmod).getTime();
      if (!Number.isNaN(t) && t < since) return false;
    }
    return true;
  });
}

/** Strip HTML tags, collapse whitespace, return first N chars. */
function stripHtml(html: string, maxChars: number): string {
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const text = noScripts.replace(/<[^>]+>/g, " ");
  return text.replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, maxChars);
}

/** Extract a single meta value by attribute. */
function metaContent(html: string, key: string, valueRegex: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:${key})\\s*=\\s*['"](?:${valueRegex})['"][^>]*content\\s*=\\s*['"]([^'"]+)['"]`, "i");
  const reReverse = new RegExp(`<meta[^>]+content\\s*=\\s*['"]([^'"]+)['"][^>]+(?:${key})\\s*=\\s*['"](?:${valueRegex})['"]`, "i");
  return html.match(re)?.[1] ?? html.match(reReverse)?.[1] ?? null;
}

/** Scrape one blog URL — extract title, description, first-500-word excerpt. */
export async function scrapeBlogPage(url: string): Promise<ScrapedBlog> {
  const html = await fetchText(url);
  if (!html) {
    return { url, title: null, description: null, excerpt: null, published_at: null };
  }

  const ogTitle = metaContent(html, "property", "og:title");
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
  const ogDesc = metaContent(html, "property", "og:description");
  const metaDesc = metaContent(html, "name", "description");
  const articleTime =
    metaContent(html, "property", "article:published_time") ??
    metaContent(html, "property", "og:article:published_time") ??
    metaContent(html, "name", "publish_date");

  // Body excerpt — grab inside <article> if present, else main, else first paragraph
  const body =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html;
  const excerpt = stripHtml(body, 2_500); // ~500 words

  return {
    url,
    title: ogTitle ?? titleTag,
    description: ogDesc ?? metaDesc,
    excerpt: excerpt || null,
    published_at: articleTime ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
export { sleep };
