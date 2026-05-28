import type { NormalizedOpportunity } from "./types.js";

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

      // Quick check: must be same state (or both null)
      if (opp.state !== existing.state) continue;

      // Title similarity check
      const sim = titleSimilarity(opp.title, existing.title);
      if (sim >= similarityThreshold) {
        // Duplicate found — keep the one with more data
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
  if (opp.naicsCode !== null) score += 1;
  if (opp.pscCode !== null) score += 1;
  if (opp.sourceUrl !== null) score += 1;
  if (opp.agency && opp.agency !== "RFPMart Source") score += 1;
  return score;
}
