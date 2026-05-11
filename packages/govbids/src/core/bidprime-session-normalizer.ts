import type { BidPrimeV2Bid } from "./bidprime-session-client.js";
import type { NormalizedOpportunity } from "./types.js";

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findCode(codes: BidPrimeV2Bid["codes"], type: string): string | null {
  const match = codes?.find((c) => c.type?.toUpperCase() === type.toUpperCase());
  return match?.code ?? null;
}

/**
 * BidPrime returns region as a 4-char `cc` + `state` code, e.g. "usny", "usca".
 * Strip the country prefix and uppercase to match the rest of the pipeline (NY, CA).
 * Non-US (e.g. "caon" Ontario) returns null since ConsultAdd is US-only.
 */
function parseRegion(region: string | number | null | undefined): string | null {
  if (region == null) return null;
  const trimmed = String(region).trim().toLowerCase();
  if (trimmed.length === 4 && trimmed.startsWith("us")) {
    return trimmed.slice(2).toUpperCase();
  }
  return null;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseEstimate(value: string | number | null): number | null {
  if (value == null) return null;
  if (typeof value === "number") return value > 0 ? value : null;
  const cleaned = value.replace(/[$,\s]/g, "");
  const num = parseFloat(cleaned);
  return !isNaN(num) && num > 0 ? num : null;
}

/**
 * Build a description string that combines the scraped HTML body
 * with any saved-search match context (matched keywords, snippets).
 *
 * Match context is prepended so the LLM scorer sees *why* this bid
 * landed in the inbox — useful for the Green/Yellow/Red classifier.
 */
function buildEnrichedDescription(raw: BidPrimeV2Bid): string {
  const parts: string[] = [];

  const matched = (raw.matchedWords ?? []).filter(Boolean);
  if (matched.length > 0) {
    parts.push(`[Matched keywords: ${matched.join(", ")}]`);
  }

  if (raw.matchedSnippets && Array.isArray(raw.matchedSnippets) && raw.matchedSnippets.length > 0) {
    const flat = raw.matchedSnippets
      .map((s) => (typeof s === "string" ? s : JSON.stringify(s)))
      .filter((s) => s.length > 0)
      .slice(0, 5)
      .join(" • ");
    if (flat) parts.push(`[Matched snippets: ${flat}]`);
  }

  const body = raw.description ? stripHtml(raw.description) : "";
  if (body) parts.push(body);

  return parts.join("\n\n");
}

export function normalizeBidPrimeV2Bid(
  raw: BidPrimeV2Bid,
): NormalizedOpportunity {
  const description = buildEnrichedDescription(raw);
  const sourceUrl = raw.link ?? null;
  const state = parseRegion(raw.region ?? raw.regionId);

  return {
    id: `bidprime-${raw.uuid}`,
    title: raw.title?.trim() ?? "",
    description,
    agency: raw.entity?.trim() ?? "",
    state,
    naicsCode: findCode(raw.codes ?? [], "NAICS"),
    pscCode: findCode(raw.codes ?? [], "PSC"),
    estimatedValue: parseEstimate(raw.estimate),
    dueDate: toIso(raw.expireDate),
    postedDate: toIso(raw.issueDate),
    capturedDate: toIso(raw.issueDate),
    type: "Solicitation",
    setAsideType: null,
    sourceUrl,
    placeOfPerformance: state,
  };
}
