export const ISSUE_PREFIX_FALLBACK = "CMP";

export function deriveIssuePrefixBase(name: string, fallback = ISSUE_PREFIX_FALLBACK): string {
  const normalized = name.toUpperCase().replace(/[^A-Z]/g, "");
  return normalized.slice(0, 3) || fallback;
}

export function issuePrefixSuffixForAttempt(attempt: number): string {
  if (attempt <= 1) return "";
  return "A".repeat(attempt - 1);
}

export function buildIssuePrefixCandidate(base: string, attempt: number): string {
  return `${base}${issuePrefixSuffixForAttempt(attempt)}`;
}
