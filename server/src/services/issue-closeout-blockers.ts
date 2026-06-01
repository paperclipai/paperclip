import { extractIssueReferenceMatches } from "@paperclipai/shared";

export type RequiredBlockerReference = {
  identifier: string;
  matchedText: string;
  line: string;
};

const BLOCKER_INTENT_RE =
  /\b(?:blocked\s+(?:by|on|until)|blockers?|blocking|blocks|depends?\s+on|dependenc(?:y|ies)|required(?:\s+downstream)?\s+blockers?|must\s+(?:complete|finish|land|ship))\b/i;
const NON_BLOCKER_INTENT_RE =
  /\b(?:no|none|without)\s+(?:required\s+)?blockers?\b|\b(?:not\s+(?:a\s+)?blocker|not\s+blocking|non[-\s]?blocking)\b/i;

function lineForIndex(text: string, index: number) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const nextNewline = text.indexOf("\n", index);
  const lineEnd = nextNewline === -1 ? text.length : nextNewline;
  return text.slice(lineStart, lineEnd).trim();
}

export function extractRequiredBlockerReferences(text: string | null | undefined): RequiredBlockerReference[] {
  if (!text) return [];

  const matches = extractIssueReferenceMatches(text);
  const seen = new Set<string>();
  const required: RequiredBlockerReference[] = [];

  for (const match of matches) {
    const line = lineForIndex(text, match.index);
    if (!BLOCKER_INTENT_RE.test(line)) continue;
    if (NON_BLOCKER_INTENT_RE.test(line)) continue;
    if (seen.has(match.identifier)) continue;
    seen.add(match.identifier);
    required.push({
      identifier: match.identifier,
      matchedText: match.matchedText,
      line,
    });
  }

  return required;
}

export function extractRequiredBlockerIssueIdentifiers(text: string | null | undefined): string[] {
  return extractRequiredBlockerReferences(text).map((reference) => reference.identifier);
}
