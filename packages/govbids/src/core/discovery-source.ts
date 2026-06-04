/**
 * Off-aggregator discovery source (Phase 1 — targeted portal crawl).
 *
 * Fetches a curated list of long-tail procurement pages (small-town / regional /
 * nonprofit) that HigherGov / RFPMart / BidPrime don't index, LLM-extracts
 * candidate RFPs from each page, and emits NormalizedOpportunity[] so the rest
 * of the pipeline (dedup → hard-filter → scorer → classify → delivery) is reused.
 *
 * See .context/epic-off-aggregator-discovery.md for the full design.
 */
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_SCORER_MODEL } from "./constants.js";
import { stateAbbrFromText } from "./state.js";
import type { NormalizedOpportunity } from "./types.js";
import { BraveClient, looksLikeProcurementUrl } from "./brave-client.js";
import type { UnicornTarget } from "./discovery-targets.js";

export interface DiscoveryTarget {
  /** Procurement / bids page URL. */
  url: string;
  /** Issuing org name (used as agency when the page doesn't state one per-RFP). */
  agency: string;
  /** US state abbreviation for the org. */
  state: string;
}

export interface DiscoveryOptions {
  apiKey: string;
  targets: DiscoveryTarget[];
  /** Per-page fetch timeout (ms). */
  timeoutMs?: number;
  /** Delay between pages to be polite (ms). */
  throttleMs?: number;
  onProgress?: (done: number, total: number) => void;
}

interface ExtractedRfp {
  title: string;
  agency?: string | null;
  dueDate?: string | null; // ISO or null
  description?: string | null;
  estimatedValue?: number | null;
  detailUrl?: string | null;
  isItRelated: boolean;
  isBiddableSolicitation: boolean; // not a meeting/minutes/permit/job-post
}

const EXTRACT_SYSTEM = `You extract government/nonprofit procurement opportunities from a web page.
Return ONLY a JSON array (no prose). Each element is an RFP/RFQ/ITB/bid currently open on the page:
{
  "title": string,
  "agency": string|null,            // the issuing org if named on the page
  "dueDate": string|null,           // ISO yyyy-mm-dd if a closing/due date is shown, else null
  "description": string|null,       // 1-2 sentence summary if available
  "estimatedValue": number|null,    // USD if stated
  "detailUrl": string|null,         // absolute URL to the RFP detail/document if present
  "isItRelated": boolean,           // true if IT/software/ERP/cyber/data/cloud/managed-services
  "isBiddableSolicitation": boolean // false for meeting minutes, agendas, permits, job postings, award notices
}
Only include rows that are actual open solicitations. If the page shows none, return [].`;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16000);
}

async function fetchPage(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Realistic browser UA — many muni portals (CivicPlus, etc.) 403 unknown
        // bots. Public procurement pages are meant to be read; we still rate-limit.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function extractRfps(
  client: Anthropic,
  pageText: string,
): Promise<ExtractedRfp[]> {
  const res = await client.messages.create({
    model: DEFAULT_SCORER_MODEL,
    max_tokens: 2048,
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: pageText }],
  });
  const text = res.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("");
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as ExtractedRfp[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function toAbsolute(base: string, maybeRelative: string | null | undefined): string | null {
  if (!maybeRelative) return null;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

function normalize(
  rfp: ExtractedRfp,
  target: DiscoveryTarget,
): NormalizedOpportunity {
  const agency = rfp.agency?.trim() || target.agency;
  const nowIso = new Date().toISOString();
  // Stable id from url + title so re-discovery dedups by id.
  const slug = `${target.url}::${rfp.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
  return {
    id: `discovery-${slug}`,
    title: rfp.title.trim(),
    description: rfp.description?.trim() || "",
    agency,
    state: stateAbbrFromText(agency) ?? target.state,
    naicsCode: null,
    pscCode: null,
    estimatedValue: rfp.estimatedValue ?? null,
    dueDate: rfp.dueDate ? new Date(rfp.dueDate).toISOString() : null,
    postedDate: nowIso,
    capturedDate: nowIso,
    type: "Solicitation",
    setAsideType: null,
    sourceUrl: toAbsolute(target.url, rfp.detailUrl) ?? target.url,
    placeOfPerformance: target.state,
  };
}

/**
 * Search-driven discovery (Phase 2): for each unicorn target, replicate a
 * human's "<town> <state> bids RFP IT" search via Brave, take the candidate
 * procurement-page URLs, and fetch+extract them. No hardcoded bid URLs.
 */
export async function discoverBySearch(opts: {
  anthropicKey: string;
  braveKey: string;
  targets: UnicornTarget[];
  resultsPerTarget?: number;
  pagesPerTarget?: number;
  timeoutMs?: number;
  throttleMs?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}): Promise<{
  opportunities: NormalizedOpportunity[];
  targetsSearched: number;
  pagesFetched: number;
  pagesFailed: number;
}> {
  const brave = new BraveClient({ apiKey: opts.braveKey });
  const client = new Anthropic({ apiKey: opts.anthropicKey });
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pagesPerTarget = opts.pagesPerTarget ?? 2;
  const out: NormalizedOpportunity[] = [];
  let pagesFetched = 0;
  let pagesFailed = 0;

  for (let i = 0; i < opts.targets.length; i++) {
    const t = opts.targets[i];
    opts.onProgress?.(i + 1, opts.targets.length, `${t.name}, ${t.state}`);
    let results;
    try {
      results = await brave.search(
        `${t.name} ${t.state} city bids RFP procurement information technology OR software OR ERP`,
        opts.resultsPerTarget ?? 5,
      );
    } catch {
      continue; // search failure for one target shouldn't kill the run
    }
    const urls = results
      .map((r) => r.url)
      .filter(looksLikeProcurementUrl)
      .slice(0, pagesPerTarget);

    for (const url of urls) {
      const html = await fetchPage(url, timeoutMs);
      if (html === null) {
        pagesFailed++;
        continue;
      }
      pagesFetched++;
      const pageText = stripHtml(html);
      if (pageText.length <= 50) continue;
      const rfps = await extractRfps(client, pageText);
      const target: DiscoveryTarget = { url, agency: `${t.name}, ${t.state}`, state: t.state };
      for (const r of rfps) {
        if (r.isItRelated && r.isBiddableSolicitation && r.title?.trim()) {
          out.push(normalize(r, target));
        }
      }
      if (opts.throttleMs) await new Promise((res) => setTimeout(res, opts.throttleMs));
    }
  }

  return { opportunities: out, targetsSearched: opts.targets.length, pagesFetched, pagesFailed };
}

export async function discoverOpportunities(
  opts: DiscoveryOptions,
): Promise<{ opportunities: NormalizedOpportunity[]; pagesFetched: number; pagesFailed: number }> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const throttleMs = opts.throttleMs ?? 800;
  const out: NormalizedOpportunity[] = [];
  let pagesFetched = 0;
  let pagesFailed = 0;

  for (let i = 0; i < opts.targets.length; i++) {
    const target = opts.targets[i];
    const html = await fetchPage(target.url, timeoutMs);
    if (html === null) {
      pagesFailed++;
    } else {
      pagesFetched++;
      const pageText = stripHtml(html);
      if (pageText.length > 50) {
        const rfps = await extractRfps(client, pageText);
        for (const r of rfps) {
          // Keep only IT-related, genuinely-biddable solicitations.
          if (r.isItRelated && r.isBiddableSolicitation && r.title?.trim()) {
            out.push(normalize(r, target));
          }
        }
      }
    }
    opts.onProgress?.(i + 1, opts.targets.length);
    if (i < opts.targets.length - 1 && throttleMs > 0) {
      await new Promise((res) => setTimeout(res, throttleMs));
    }
  }

  return { opportunities: out, pagesFetched, pagesFailed };
}
