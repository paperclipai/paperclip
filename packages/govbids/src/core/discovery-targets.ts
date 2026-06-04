/**
 * "Unicorn" discovery targets — overlooked, fast-growing US municipalities,
 * counties, and institutions that the major aggregators (HigherGov / RFPMart /
 * BidPrime) under-index and where vendor competition is thin. Strategy: a town
 * that quadrupled since 2020 is buying new ERP / IT / cyber / data systems but
 * isn't on the big portals — high win-rate, low competition.
 *
 * Grounded in 2024-2025 Census growth data (Vintage 2025 city/town estimates):
 * the Dallas-Fort Worth exurb corridor, Mountain West (UT "Silicon Slopes",
 * AZ), Southeast (FL, SC, NC, TN), and ID Treasure Valley dominate small-city
 * growth. We search each by name (replicating a human's "<town> <state> bids"
 * google), so we don't hardcode brittle bid-page URLs.
 */
export interface UnicornTarget {
  name: string;
  state: string;
  /** growth note for prioritization / audit */
  note?: string;
  kind?: "city" | "town" | "county" | "institution";
}

export const UNICORN_TARGETS: UnicornTarget[] = [
  // ── Texas — DFW & Austin exurb corridors (nation's fastest %) ──
  { name: "Celina", state: "TX", note: "+276% since 2020", kind: "city" },
  { name: "Princeton", state: "TX", note: "+30%/yr, doubled since 2020", kind: "city" },
  { name: "Prosper", state: "TX", note: "DFW exurb boom", kind: "town" },
  { name: "Anna", state: "TX", note: "Collin County boom", kind: "city" },
  { name: "Melissa", state: "TX", note: "Collin County boom", kind: "city" },
  { name: "Fate", state: "TX", note: "+11.4%/yr", kind: "city" },
  { name: "Royse City", state: "TX", note: "+12.6%/yr", kind: "city" },
  { name: "Forney", state: "TX", note: "Kaufman County boom", kind: "city" },
  { name: "Fulshear", state: "TX", note: "+16.4%/yr, Houston exurb", kind: "city" },
  { name: "Leander", state: "TX", note: "fastest small city <200k", kind: "city" },
  { name: "Hutto", state: "TX", note: "Austin exurb", kind: "city" },
  { name: "Kyle", state: "TX", note: "Austin corridor", kind: "city" },
  { name: "Buda", state: "TX", note: "Austin corridor", kind: "city" },
  { name: "Manor", state: "TX", note: "Austin exurb", kind: "city" },

  // ── Utah — Silicon Slopes (Salt Lake/Utah County) ──
  { name: "Saratoga Springs", state: "UT", note: "Utah County boom", kind: "city" },
  { name: "Eagle Mountain", state: "UT", note: "fast-growth exurb", kind: "city" },
  { name: "Herriman", state: "UT", note: "SL County boom", kind: "city" },
  { name: "Lehi", state: "UT", note: "Silicon Slopes core", kind: "city" },

  // ── Arizona — Phoenix exurbs ──
  { name: "Buckeye", state: "AZ", note: "fastest-growing AZ city", kind: "city" },
  { name: "Queen Creek", state: "AZ", note: "Phoenix exurb boom", kind: "town" },
  { name: "Maricopa", state: "AZ", note: "Pinal County boom", kind: "city" },
  { name: "Goodyear", state: "AZ", note: "West Valley growth", kind: "city" },

  // ── South Carolina / North Carolina — Charlotte/Raleigh exurbs ──
  { name: "Fort Mill", state: "SC", note: "Charlotte exurb", kind: "town" },
  { name: "Indian Land", state: "SC", note: "Lancaster County boom", kind: "town" },
  { name: "Apex", state: "NC", note: "Raleigh exurb", kind: "town" },
  { name: "Holly Springs", state: "NC", note: "Raleigh exurb", kind: "town" },
  { name: "Fuquay-Varina", state: "NC", note: "Raleigh exurb", kind: "town" },
  { name: "Wake Forest", state: "NC", note: "Raleigh exurb", kind: "town" },

  // ── Tennessee — Nashville exurbs ──
  { name: "Spring Hill", state: "TN", note: "Nashville exurb boom", kind: "city" },
  { name: "Nolensville", state: "TN", note: "Williamson County boom", kind: "town" },
  { name: "Thompson's Station", state: "TN", note: "Williamson County boom", kind: "town" },

  // ── Idaho — Treasure Valley (Boise metro) ──
  { name: "Meridian", state: "ID", note: "Boise metro boom", kind: "city" },
  { name: "Star", state: "ID", note: "fastest-growth ID", kind: "city" },
  { name: "Kuna", state: "ID", note: "Boise exurb", kind: "city" },
  { name: "Eagle", state: "ID", note: "Boise exurb", kind: "city" },

  // ── Florida — overlooked fast-growth (not the big metros) ──
  { name: "Wildwood", state: "FL", note: "The Villages growth", kind: "city" },
  { name: "Groveland", state: "FL", note: "Lake County boom", kind: "city" },
  { name: "Minneola", state: "FL", note: "Lake County boom", kind: "city" },

  // ── Counties + institutions (overlooked, growing) ──
  { name: "Comal County", state: "TX", note: "fast-growth county (New Braunfels)", kind: "county" },
  { name: "St. Johns County", state: "FL", note: "fast-growth county", kind: "county" },
  { name: "Lancaster County", state: "SC", note: "Indian Land growth", kind: "county" },
];
