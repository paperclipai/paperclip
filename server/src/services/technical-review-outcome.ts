/**
 * Classifies free-text technical review summaries for automated parent-issue reconciliation.
 * @see docs/guides/board-operator/runtime-runbook.md — technical review dispatch
 * @see doc/plans/2026-04-05-review-outcome-classification-matrix.md
 */

export function normalizeReviewText(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase();
}

export function extractMarkdownSection(body: string, heading: RegExp) {
  const match = body.match(heading);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const rest = body.slice(start);
  const nextHeading = rest.search(/\n###\s+/);
  return (nextHeading >= 0 ? rest.slice(0, nextHeading) : rest).trim();
}

export function classifyTechnicalReviewOutcome(commentBody: string | null | undefined) {
  if (!commentBody) return null;

  const normalized = normalizeReviewText(commentBody);
  if (/retornar[\s\S]*`in_progress`/.test(normalized)) return "blocking" as const;
  if (
    /\bpode seguir para revisao humana\b/.test(normalized)
    || /\bpronto para revisao humana\b/.test(normalized)
    || /\baprovad[oa]\s+para\s+revisao humana\b/.test(normalized)
  ) {
    return "approved" as const;
  }
  if (
    /\bready for human review\b/.test(normalized)
    || /\bapproved for human review\b/.test(normalized)
    || /\bok to proceed to human review\b/.test(normalized)
    || /\blgtm for human review\b/.test(normalized)
    || /\bno blocking findings\b/.test(normalized)
    || /\bnon-blocking review\b/.test(normalized)
    || /\bship to human review\b/.test(normalized)
  ) {
    return "approved" as const;
  }

  const blockingSection = extractMarkdownSection(
    commentBody,
    /^###\s+(?:findings?\s+bloqueantes?|blocking\s+findings?|blocking)(?:\s+\(\d+\))?\s*$/im,
  );
  if (!blockingSection) return null;

  const collapsed = normalizeReviewText(blockingSection)
    .replace(/[`*_>#\-\d.[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!collapsed) return null;
  if (
    /\b(nenhum|nenhuma|nao ha|sem findings? bloqueantes?|none|n\/a)\b/.test(collapsed)
  ) {
    return "approved" as const;
  }
  return "blocking" as const;
}
