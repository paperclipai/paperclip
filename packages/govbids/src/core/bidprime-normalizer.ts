import type { BidPrimeBid } from "./bidprime-client.js";
import type { NormalizedOpportunity } from "./types.js";

const STATE_NAME_TO_ABBREV: Record<string, string> = {
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
};

function toStateAbbrev(region: string | null): string | null {
  if (!region) return null;
  const trimmed = region.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_NAME_TO_ABBREV[trimmed.toLowerCase()] ?? null;
}

function findCode(codes: BidPrimeBid["codes"], type: string): string | null {
  const match = codes.find((c) => c.type?.toUpperCase() === type.toUpperCase());
  return match?.code ?? null;
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function normalizeBidPrimeBid(raw: BidPrimeBid): NormalizedOpportunity {
  const state = toStateAbbrev(raw.region);
  const sourceUrl =
    raw.publisherLink || raw.directLink || raw.bidprimeLink || null;

  return {
    id: `bidprime-${raw.id}`,
    title: raw.title?.trim() ?? "",
    description: raw.description?.trim() ?? "",
    agency: raw.entity?.trim() ?? "",
    state,
    naicsCode: findCode(raw.codes, "NAICS"),
    pscCode: findCode(raw.codes, "PSC"),
    estimatedValue: null,
    dueDate: toIso(raw.expiresAt),
    postedDate: toIso(raw.issuedAt),
    capturedDate: toIso(raw.notifiedAt ?? raw.issuedAt),
    type: "Solicitation",
    setAsideType: null,
    sourceUrl,
    placeOfPerformance: state,
  };
}
