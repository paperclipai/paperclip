/**
 * Detect addendum / amendment / re-post / deadline-extension notifications.
 *
 * Sources (esp. BidPrime) re-emit an existing solicitation when an addendum
 * is issued — same underlying RFP, often a fresh source id. The team only
 * wants brand-new RFPs in the main digest; these get routed to a separate
 * "Addenda & Updates" section instead.
 */
const ADDENDUM_PATTERNS: RegExp[] = [
  /\baddend(?:um|a)\b/i,
  /\bamendment\b/i,
  /\bamended\b/i,
  /\bre-?post(?:ed|ing)?\b/i,
  /\bre-?issue(?:d)?\b/i,
  /\bre-?bid\b/i,
  /\brebid\b/i,
  /\brevised\b/i,
  /\(rev\.?\s*\d*\)/i,
  /\bdeadline\s+extend(?:ed|sion)?\b/i,
  /\bextension\s+of\s+(?:the\s+)?(?:deadline|due\s+date|closing\s+date)\b/i,
  /\bdue\s+date\s+extend(?:ed|sion)?\b/i,
  /\bupdate[d]?\s*[-:#]/i,
];

/**
 * Returns true if the title looks like an addendum / amendment / re-post /
 * deadline change rather than a brand-new solicitation.
 */
export function isAddendumOrRepost(title: string): boolean {
  if (!title) return false;
  return ADDENDUM_PATTERNS.some((re) => re.test(title));
}

/**
 * US-3: Q&A / clarification / RFI-response documents are NOT biddable
 * solicitations — they're supporting artifacts attached to an existing RFP.
 * They belong in neither the Qualified sheet nor the Addenda tab; they are
 * dropped entirely.
 */
const QANDA_PATTERNS: RegExp[] = [
  /\bq\s*&\s*a\b/i,
  /\bq\s*and\s*a\b/i,
  /\bquestions?\s+(and|&)\s+answers?\b/i,
  // "Answers to Questions" / "Answers to Vendor Questions" — allow words between.
  /\banswers?\s+to\s+(?:\w+\s+){0,3}questions?\b/i,
  /\bquestion\s+(and\s+)?responses?\b/i,
  /\bclarification(s)?\b/i,
  /\brfi\s+responses?\b/i,
  /\bresponses?\s+to\s+(?:\w+\s+){0,3}questions?\b/i,
];

export function isQandA(title: string): boolean {
  if (!title) return false;
  return QANDA_PATTERNS.some((re) => re.test(title));
}
