// Helpers for detecting a provider context-overflow failure and for sizing the
// session on the same token axis the provider refuses on.
//
// The OpenCode free tiers answer an over-long request with HTTP 400
// `invalid_request_error` and the message "The request contains invalid
// parameters", after the DCP plugin has injected a
// `<dcp-system-reminder> ... MAX CONTEXT LIMIT ...` block into the transcript.
// All of these shapes describe one condition: the session is too large to
// resume. A fresh dispatch must therefore start a new session instead of
// handing the provider the same poisoned one again.

export function isContextOverflowErrorText(...values: unknown[]): boolean {
  const haystack = values
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length > 0,
    )
    .join("\n")
    .toLowerCase();
  if (!haystack.includes("invalid_request_error")) return false;
  return (
    haystack.includes("invalid parameters") ||
    haystack.includes("max context limit") ||
    haystack.includes("dcp-system-reminder")
  );
}

export function isContextOverflowRun(run: {
  errorCode?: string | null;
  error?: string | null;
  resultJson?: unknown;
}): boolean {
  let serialized = "";
  try {
    serialized = JSON.stringify(run);
  } catch {
    serialized = "";
  }
  return isContextOverflowErrorText(run.errorCode, run.error, serialized);
}

export type RawUsageTokenTotals = {
  inputTokens: number;
  cachedInputTokens: number;
};

// The usage writer (run-completion) stores exclusive raw input and stamps
// `rawInputIncludesCached: false`. That stamp is missing on older rows and on
// runs that reported no raw usage at all, so a `=== false` identity test
// silently dropped the cache term on exactly the runs that overflowed. Add the
// separate cache counter unless the writer explicitly declared the input
// already includes it.
export function sumSessionRawInputTokens(
  rawUsage: RawUsageTokenTotals | null | undefined,
  usageJson: Record<string, unknown> | null | undefined,
): number {
  if (!rawUsage) return 0;
  const inputIncludesCached = usageJson?.rawInputIncludesCached === true;
  return (
    rawUsage.inputTokens +
    (inputIncludesCached ? 0 : rawUsage.cachedInputTokens)
  );
}
