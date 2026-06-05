import type { NormalizedOpportunity } from "./types.js";
import { stateAbbrFromText } from "./state.js";

/**
 * Normalize a title for fuzzy matching across sources.
 * Strips common prefixes, punctuation, extra whitespace, and lowercases.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(rfp|rfq|ifb|solicitation|bid)\s*[-:#]?\s*/i, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Simple Jaccard similarity on word sets.
 */
function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalizeTitle(a).split(" ").filter((w) => w.length > 2));
  const wordsB = new Set(normalizeTitle(b).split(" ").filter((w) => w.length > 2));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/**
 * Deduplicate opportunities across multiple sources (HigherGov + RFPMart).
 *
 * Uses title similarity + same state as the match criteria since
 * different platforms use completely different ID systems.
 *
 * When duplicates are found, keeps the one with more data (longer description,
 * has due date, has value, etc.).
 */
export function crossSourceDedup(
  opportunities: NormalizedOpportunity[],
  similarityThreshold: number = 0.7,
): { deduped: NormalizedOpportunity[]; duplicatesRemoved: number } {
  const kept: NormalizedOpportunity[] = [];
  let duplicatesRemoved = 0;

  for (const opp of opportunities) {
    let isDuplicate = false;

    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i];

      // US-2: states must be compatible, but a NULL state is a wildcard.
      // OpenText Support Services arrives as BidPrime(state=PA) and
      // RFPMart(state=null) — same solicitation, different state completeness.
      // Requiring an exact state match let both survive. Null-matches-any fixes it,
      // while the title-similarity gate below still prevents two different RFPs that
      // merely share a state from collapsing.
      const statesCompatible =
        opp.state === existing.state ||
        opp.state === null ||
        existing.state === null;
      if (!statesCompatible) continue;

      // Title similarity check
      const sim = titleSimilarity(opp.title, existing.title);
      if (sim >= similarityThreshold) {
        // Duplicate found — keep the one with more data (richer record wins).
        const oppScore = dataRichness(opp);
        const existingScore = dataRichness(existing);

        if (oppScore > existingScore) {
          kept[i] = opp; // Replace with richer record
        }
        isDuplicate = true;
        duplicatesRemoved++;
        break;
      }
    }

    if (!isDuplicate) {
      kept.push(opp);
    }
  }

  return { deduped: kept, duplicatesRemoved };
}

/**
 * Score how much useful data an opportunity has (for choosing between duplicates).
 */
function dataRichness(opp: NormalizedOpportunity): number {
  let score = 0;
  if (opp.description.length > 100) score += 3;
  if (opp.estimatedValue !== null) score += 2;
  if (opp.dueDate !== null) score += 2;
  // US-2: a known state is a strong completeness signal. For the OpenText pair,
  // this lets the BidPrime record (state=PA, specific agency "Philadelphia Gas
  // Works") win over the RFPMart record (state=null, bare "Pennsylvania").
  if (opp.state !== null) score += 2;
  if (opp.naicsCode !== null) score += 1;
  if (opp.pscCode !== null) score += 1;
  if (opp.sourceUrl !== null) score += 1;
  // A specific agency beats a bare state name. RFPMart often sets agency to the
  // state name ("Pennsylvania"); don't reward that as a "real" agency.
  if (
    opp.agency &&
    opp.agency !== "RFPMart Source" &&
    !isBareStateName(opp.agency)
  ) {
    score += 1;
  }
  return score;
}

/** True when the agency string is just a US state/territory name (RFPMart quirk). */
function isBareStateName(agency: string): boolean {
  return stateAbbrFromText(agency.trim()) !== null && /^[A-Za-z .]+$/.test(agency.trim()) &&
    agency.trim().split(/\s+/).length <= 3 && !/county|city|district|department|authority|university|board|office|agency|state of/i.test(agency);
}
