type RunWithErrorFields = {
  errorCode: string | null;
  error: string | null;
};

/**
 * Returns true when the run failed because the org's Claude API quota was
 * exhausted ("You've hit your org's monthly usage limit").  These failures
 * are an external billing constraint, not an agent failure, so they must not
 * trigger "Recover stalled issues" escalation tickets.
 */
export function isQuotaLimitExhaustionRun(run: RunWithErrorFields | null): boolean {
  if (!run) return false;
  return (
    run.errorCode === "claude_transient_upstream" &&
    typeof run.error === "string" &&
    run.error.toLowerCase().includes("monthly usage limit")
  );
}
