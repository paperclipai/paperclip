import type { HigherGovOpportunity, NormalizedOpportunity } from "./types.js";

const HIGHERGOV_BASE = "https://www.highergov.com";

/**
 * Extract and clean key fields from a raw HigherGov API response.
 * Handles nested objects and missing/null fields gracefully.
 */
export function normalizeOpportunity(
  raw: HigherGovOpportunity,
): NormalizedOpportunity {
  // Use the higher of val_est_low and val_est_high, or average them
  const valLow = parseValue(raw.val_est_low);
  const valHigh = parseValue(raw.val_est_high);
  const estimatedValue =
    valLow !== null && valHigh !== null
      ? (valLow + valHigh) / 2
      : valHigh ?? valLow;

  // Build place of performance string
  const popParts = [raw.pop_city, raw.pop_state].filter(Boolean);
  const placeOfPerformance = popParts.length > 0 ? popParts.join(", ") : null;

  return {
    id: raw.opp_key,
    title: raw.title ?? "",
    description: raw.ai_summary || raw.description_text || "",
    agency: raw.agency?.agency_name ?? "",
    state: raw.pop_state ?? null,
    naicsCode: raw.naics_code?.naics_code ?? null,
    pscCode: raw.psc_code?.psc_code ?? null,
    estimatedValue,
    dueDate: parseDate(raw.due_date),
    postedDate: parseDate(raw.posted_date),
    capturedDate: parseDate(raw.captured_date),
    type: raw.opp_type?.description ?? null,
    setAsideType: raw.set_aside?.description ?? null,
    sourceUrl: raw.path
      ? raw.path.startsWith("http") ? raw.path : `${HIGHERGOV_BASE}${raw.path}`
      : null,
    placeOfPerformance,
  };
}

function parseDate(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "string" ? parseFloat(value) : Number(value);
  if (isNaN(num)) return null;
  return num;
}
