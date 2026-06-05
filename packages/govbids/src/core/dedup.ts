import type { NormalizedOpportunity } from "./types.js";

/**
 * Deduplicate opportunities by ID.
 * When duplicates are found, keeps the one with the most recent capturedDate.
 */
export function deduplicateByOpportunityId(
  opportunities: NormalizedOpportunity[],
): NormalizedOpportunity[] {
  const seen = new Map<string, NormalizedOpportunity>();

  for (const opp of opportunities) {
    const existing = seen.get(opp.id);
    if (!existing) {
      seen.set(opp.id, opp);
      continue;
    }

    // Keep the one with the most recent capturedDate
    if (opp.capturedDate && existing.capturedDate) {
      if (new Date(opp.capturedDate) > new Date(existing.capturedDate)) {
        seen.set(opp.id, opp);
      }
    } else if (opp.capturedDate && !existing.capturedDate) {
      seen.set(opp.id, opp);
    }
  }

  return Array.from(seen.values());
}
