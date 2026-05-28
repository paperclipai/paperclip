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
