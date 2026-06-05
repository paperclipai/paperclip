/**
 * Paperclip issue-identifier extraction from GitHub PR text.
 *
 * Centralized so the webhook receiver (forward capture) and the
 * issue↔PR linkage service (storage + backfill reconciler) share ONE
 * extractor. The operator hard-guard (2026-06-05) is that PR→issue
 * attribution keys on the `BLO-####` ref in branch/title/body — NEVER on
 * the PR author login — because agent merged-PRs span ≥2 GitHub identities
 * (kkroo, app/allyblockcast, app/blockcast-ci-packages) and an author filter
 * silently drops whole identity buckets (the BLO-9103 floor bug). Keeping the
 * extractor in one place means that guarantee can't drift between the two paths.
 *
 * Logic is verbatim from the original webhook implementation (BLO-3182).
 */

// Conservative pattern: 2-10 uppercase letters/digits, dash, 1-6 digits.
// Anchored against word boundaries so mid-word `xBLO-3182y` doesn't match,
// but `(BLO-3182)`, `BLO-3182:`, or `feat/BLO-3182-thing` all do.
// Compact lists such as `BLO-3763/3764` are expanded to both identifiers.
export const PAPERCLIP_IDENTIFIER_PATTERN = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6}(?:\/\d{1,6})*)\b/g;
export const PAPERCLIP_COMPACT_IDENTIFIER_PATTERN = /^([A-Z][A-Z0-9]{1,9})-(\d{1,6})((?:\/\d{1,6})*)$/;

export function expandPaperclipIdentifierToken(token: string): string[] {
  const match = token.match(PAPERCLIP_COMPACT_IDENTIFIER_PATTERN);
  if (!match) return [token];
  const prefix = match[1]!;
  const firstNumber = match[2]!;
  const tailNumbers = (match[3] ?? "").split("/").filter(Boolean);
  return [firstNumber, ...tailNumbers].map((number) => `${prefix}-${number}`);
}

export function extractPaperclipIdentifiers(...sources: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    const matches = source.matchAll(PAPERCLIP_IDENTIFIER_PATTERN);
    for (const match of matches) {
      if (match[1]) {
        for (const identifier of expandPaperclipIdentifierToken(match[1])) {
          found.add(identifier);
        }
      }
    }
  }
  return Array.from(found);
}

/** How an issue↔PR link was established. Author is deliberately NOT a source. */
export type PullRequestLinkSource = "branch_ref" | "title_ref" | "body_ref" | "reconciler" | "manual";

export interface ResolvedPrLink {
  identifier: string;
  linkSource: PullRequestLinkSource;
}

/**
 * Resolve which PR field carried a given target identifier, preferring the
 * branch (option (A): the branchTemplate injects the issue ref into the branch
 * name, so a branch match is the strongest, process-enforced signal), then
 * title, then body. Returns null if none of the fields carry it.
 */
export function resolveLinkSourceForIdentifier(
  identifier: string,
  fields: { branch?: string | null; title?: string | null; body?: string | null },
): PullRequestLinkSource | null {
  if (extractPaperclipIdentifiers(fields.branch).includes(identifier)) return "branch_ref";
  if (extractPaperclipIdentifiers(fields.title).includes(identifier)) return "title_ref";
  if (extractPaperclipIdentifiers(fields.body).includes(identifier)) return "body_ref";
  return null;
}

/**
 * Pick the primary identifier for a PR (branch-first, then title, then body)
 * along with its link source. Multi-BLO PRs attribute to the primary; the rest
 * are still returned for callers that want them. Returns an empty array when the
 * PR carries no resolvable ref (the option-(C) unattributed tail).
 */
export function resolvePrLinks(fields: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): ResolvedPrLink[] {
  const all = extractPaperclipIdentifiers(fields.branch, fields.title, fields.body);
  const links: ResolvedPrLink[] = [];
  // Order by source strength: branch refs first.
  for (const source of ["branch", "title", "body"] as const) {
    for (const identifier of extractPaperclipIdentifiers(fields[source])) {
      if (links.some((l) => l.identifier === identifier)) continue;
      links.push({
        identifier,
        linkSource: source === "branch" ? "branch_ref" : source === "title" ? "title_ref" : "body_ref",
      });
    }
  }
  // Defensive: any identifier the combined pass found but the per-source pass
  // missed (should not happen) is appended as body_ref rather than dropped.
  for (const identifier of all) {
    if (!links.some((l) => l.identifier === identifier)) {
      links.push({ identifier, linkSource: "body_ref" });
    }
  }
  return links;
}
