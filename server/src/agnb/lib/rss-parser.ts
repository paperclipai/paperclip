/**
 * Minimal RSS / Atom parser. Regex-based. Good enough for 95% of feeds.
 * No external deps. Skips malformed entries gracefully.
 */

export interface RssItem { title: string; url: string; summary: string; published_at: string | null }

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function stripHtml(s: string): string {
  return unwrapCdata(s).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export async function fetchRssFeed(url: string): Promise<RssItem[]> {
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 FinnBot/1.0", "accept": "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    return parseFeed(xml);
  } catch { return []; }
}

function parseFeed(xml: string): RssItem[] {
  const items: RssItem[] = [];
  // RSS: <item>...</item>; Atom: <entry>...</entry>
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const b of blocks) {
    const title = stripHtml(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    // RSS uses <link>url</link>, Atom uses <link href="..."/>
    const linkHref = b.match(/<link[^>]+href="([^"]+)"/i)?.[1];
    const linkText = b.match(/<link\b[^>]*>\s*([^<]+?)\s*<\/link>/i)?.[1];
    const url = decodeXmlEntities((linkHref ?? linkText ?? "").trim());
    const summary = stripHtml(
      b.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] ??
      b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ??
      b.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] ?? ""
    ).slice(0, 500);
    const pubText = b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ??
      b.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ??
      b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1];
    let published_at: string | null = null;
    if (pubText) {
      const d = new Date(pubText.trim());
      if (!Number.isNaN(d.getTime())) published_at = d.toISOString();
    }
    if (title && url) items.push({ title, url, summary, published_at });
  }
  return items;
}
