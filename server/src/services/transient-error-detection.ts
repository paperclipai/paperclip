/**
 * Detects transient upstream API errors that are eligible for automatic retry.
 *
 * These patterns match known transient failure responses from providers like
 * Anthropic (Claude), OpenAI, and other upstream APIs:
 * - HTTP 500 Internal Server Error
 * - HTTP 503 Service Unavailable
 * - HTTP 529 Overloaded (Anthropic-specific)
 * - Structured error types: overloaded_error, api_error
 */

export const TRANSIENT_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\b500\b.*(?:internal\s*server\s*error|api_error)/i,
  /\b529\b.*overloaded/i,
  /\b503\b.*(?:service\s*unavailable|temporarily\s*unavailable)/i,
  /overloaded_error/i,
  /"type"\s*:\s*"overloaded_error"/,
  /"type"\s*:\s*"api_error".*\b500\b/,
  /API\s*Error:\s*(?:500|529|503)\b/i,
];

export function isTransientApiError(
  errorMessage: string | null | undefined,
  stderrExcerpt: string | null | undefined,
): boolean {
  const combined = [errorMessage ?? "", stderrExcerpt ?? ""].join("\n");
  if (!combined.trim()) return false;
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(combined));
}
