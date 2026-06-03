import type { RfpMartRawOpportunity } from "./rfpmart-client.js";
import type { NormalizedOpportunity } from "./types.js";
import { stateAbbrFromText } from "./state.js";

/**
 * US state ID → abbreviation lookup for RFPMart.
 * Built from their state reference JSON (US states only).
 */
const STATE_MAP: Record<string, string> = {
  "5": "NY", "48": "AL", "49": "AK", "51": "AZ", "52": "AR", "53": "CA",
  "54": "CO", "55": "CT", "56": "DE", "57": "DC", "58": "FL", "59": "GA",
  "61": "HI", "62": "ID", "63": "IL", "64": "IN", "65": "IA", "66": "KS",
  "67": "KY", "68": "LA", "69": "ME", "70": "MD", "71": "MA", "72": "MI",
  "73": "MN", "74": "MS", "75": "MO", "76": "MT", "77": "NE", "78": "NV",
  "79": "NH", "80": "NJ", "81": "NM", "82": "NC", "83": "ND", "84": "OH",
  "85": "OK", "86": "OR", "87": "PA", "89": "RI", "90": "SC", "91": "SD",
  "92": "TN", "93": "TX", "94": "UT", "95": "VT", "96": "VA", "97": "WA",
  "98": "WV", "99": "WI", "100": "WY",
};

/**
 * Category ID → rough NAICS mapping for ConsultAdd scoring context.
 */
const CATEGORY_TO_NAICS: Record<string, string> = {
  "1": "541511",  // Web Design → Custom Programming
  "7": "541512",  // Software/System → Computer Systems Design
  "26": "541512", // Networking → Computer Systems Design
  "34": "541611", // Professional Consulting
  "37": "541513", // IT Services → Computer Facilities Management
  "38": "518210", // Data Research → Data Processing
  "39": "541512", // Staffing → Computer Systems Design
  "40": "541511", // Mobile App Dev → Custom Programming
  "89": "541519", // AI/ML → Other Computer Related
};

/**
 * Normalize an RFPMart opportunity into the shared NormalizedOpportunity format.
 */
export function normalizeRfpMartOpportunity(
  raw: RfpMartRawOpportunity,
): NormalizedOpportunity {
  const budget = parseBudget(raw.rfpmart_budget, raw.rfpmart_budget_2);
  const { title, agency } = parseTitleAndAgency(raw.rfpmart_title, raw.rfpmart_scope_1);

  // US-1: the `USA (Texas) - ...` title prefix (now in `agency`) is the source of
  // truth for location. The numeric STATE_MAP code is unreliable (observed a Texas
  // RFP coded "UT"). Prefer the title-derived state; fall back to the numeric code.
  const state =
    stateAbbrFromText(agency) ?? STATE_MAP[raw.rfpmart_state] ?? null;

  return {
    id: `rfpmart-${raw.rfpmart_rfp_id}`,
    title,
    description: raw.rfpmart_scope_1 || raw.rfpmart_scope_2 || "",
    agency,
    state,
    naicsCode: CATEGORY_TO_NAICS[raw.rfpmart_category] ?? null,
    pscCode: null,
    estimatedValue: budget,
    dueDate: parseDate(raw.rfpmart_rfp_deadline),
    postedDate: parseDate(raw.rfpmart_rfp_date),
    capturedDate: parseDate(raw.rfpmart_rfp_date),
    type: "Solicitation", // RFPMart only lists RFPs
    setAsideType: null,
    sourceUrl: raw.rfpmart_link || raw.rfpmart_rfp_pub_url || null,
    placeOfPerformance: state,
  };
}

function parseDate(value: string | null | undefined): string | null {
  if (!value || value === "0000-00-00") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parseBudget(b1: string, b2: string): number | null {
  // Try budget_2 first (often more specific), then budget
  for (const val of [b2, b1]) {
    if (!val) continue;
    const cleaned = val.replace(/[$,\s]/g, "");
    const num = parseFloat(cleaned);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

/**
 * RFPMart titles are formatted as `USA (City, State) - Real Title` (or `USA (State) - ...`).
 * Extract the location into agency and strip the prefix from the title so lawyers
 * see clean data instead of "RFPMart Source".
 *
 * Falls back to scanning the description for "Agency of X" / "City of X" patterns
 * when the title doesn't match the USA-prefix shape.
 */
function parseTitleAndAgency(
  rawTitle: string | null | undefined,
  description: string,
): { title: string; agency: string } {
  const title = (rawTitle ?? "").trim();

  // USA (City, State) - Title  OR  USA (State) - Title
  const usaPrefix = title.match(/^USA\s*\(([^)]+)\)\s*[-–—]\s*(.+)$/i);
  if (usaPrefix) {
    const location = usaPrefix[1].trim();
    const cleanedTitle = usaPrefix[2].trim();
    return { title: cleanedTitle, agency: location };
  }

  // Fallback patterns from description text
  const text = description || title;
  const patterns = [
    /(?:issued by|from|by)\s+(?:the\s+)?([A-Z][A-Za-z\s]+(?:Department|Agency|Office|County|City|University|District|Authority|Commission))/i,
    /^((?:City|County|State|Department|University|Office)\s+of\s+[A-Za-z\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { title, agency: match[1].trim() };
  }

  return { title, agency: "RFPMart (agency in title)" };
}
