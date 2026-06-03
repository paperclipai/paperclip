/**
 * US state / territory name <-> abbreviation utilities.
 *
 * Round-4 US-1: RFPMart sets `state` from a numeric code that is sometimes
 * wrong (e.g. a Texas RFP coded "UT"), while the human-readable location lives
 * in the `USA (Texas) - ...` title prefix that becomes the `agency`. The title
 * prefix is the source of truth; this module maps that location name to the
 * correct abbreviation.
 */

export const STATE_NAME_TO_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI",
  idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
  // Territories + DC (in scope per US-4 decision)
  "puerto rico": "PR", guam: "GU", "u s virgin islands": "VI",
  "virgin islands": "VI", "american samoa": "AS",
  "northern mariana islands": "MP",
};

/** All valid 2-letter codes the pipeline accepts (states + DC + territories). */
export const VALID_STATE_ABBRS: Set<string> = new Set(
  Object.values(STATE_NAME_TO_ABBR),
);

/**
 * Extract a US state/territory abbreviation from a free-text location.
 *
 * Handles: bare state name ("Texas"), "City, State" ("Hartford, Connecticut",
 * "Oakland, California"), and strings that already contain an abbreviation
 * ("Newnan, GA"). Returns null if no US state can be identified.
 */
export function stateAbbrFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned) return null;

  // 1. Already an exact abbreviation?
  const upper = cleaned.toUpperCase();
  if (upper.length === 2 && VALID_STATE_ABBRS.has(upper)) return upper;

  // 2. Try the last comma-separated component first (City, State), then the whole string.
  const parts = cleaned.split(",").map((p) => p.trim()).filter(Boolean);
  const candidates = [...parts.reverse(), cleaned];

  for (const cand of candidates) {
    const lower = cand.toLowerCase();
    if (STATE_NAME_TO_ABBR[lower]) return STATE_NAME_TO_ABBR[lower];
    const candUpper = cand.toUpperCase();
    if (candUpper.length === 2 && VALID_STATE_ABBRS.has(candUpper)) return candUpper;
  }

  // 3. Scan for any full state name appearing as a whole word in the text.
  const hay = ` ${cleaned.toLowerCase()} `;
  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    if (hay.includes(` ${name} `)) return abbr;
  }

  return null;
}
