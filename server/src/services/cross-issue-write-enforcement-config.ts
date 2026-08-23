/**
 * Cutover switch parsing for the deny-by-default cross-issue write grant
 * (FAI-10132). Dependency-free on purpose: `config.ts` validates it at startup
 * without pulling in the service layer, so an operator who mistypes the
 * timestamp learns at boot instead of silently keeping the broad writes.
 */

export const CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV = "CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT";

export class CrossIssueWriteGrantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossIssueWriteGrantConfigError";
  }
}

/**
 * Absent means observe — that is the shipped default and a deliberate posture.
 * Present-but-unparseable means an operator *intended* a cutover and typed it
 * wrong; treating that as observe is a silent fail-open, so it is a hard error
 * (FAI-10134 blocking finding 4).
 */
export function parseCrossIssueWriteGrantEnforceAt(raw: string | null | undefined): Date | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new CrossIssueWriteGrantConfigError(
      `${CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV} must be an ISO-8601 timestamp (for example ` +
        `"2026-09-01T00:00:00.000Z"); received ${JSON.stringify(trimmed)}. Unset the variable to ` +
        `stay in observe mode — an unparseable value is not treated as "not armed".`,
    );
  }
  return parsed;
}

/** Startup validation hook. Throws with the message above on an invalid value. */
export function assertCrossIssueWriteGrantEnforceAtConfig(env: NodeJS.ProcessEnv = process.env) {
  parseCrossIssueWriteGrantEnforceAt(env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV]);
}
