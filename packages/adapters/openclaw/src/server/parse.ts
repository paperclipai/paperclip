// ---------------------------------------------------------------------------
// OpenClaw RPC response parsing utilities
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON-RPC response payload from the OpenClaw `agent` method
 * into a normalised shape.
 */
export function parseOpenClawAgentResult(payload: Record<string, unknown>): {
  status: string;
  summary: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
} {
  const status =
    typeof payload.status === "string" && payload.status.length > 0
      ? payload.status
      : "unknown";

  const summary = extractSummary(payload);

  const result =
    typeof payload.result === "object" &&
    payload.result !== null &&
    !Array.isArray(payload.result)
      ? (payload.result as Record<string, unknown>)
      : null;

  const error = isOpenClawError(payload)
    ? (typeof payload.error === "string" && payload.error.length > 0
        ? payload.error
        : typeof payload.summary === "string" && payload.summary.length > 0
          ? payload.summary
          : `Agent run failed with status: ${status}`)
    : null;

  return { status, summary, result, error };
}

/**
 * Returns `true` when the payload represents an error response from the
 * OpenClaw gateway (status "error" or the top-level `ok` flag is false).
 */
export function isOpenClawError(payload: Record<string, unknown>): boolean {
  if (payload.ok === false) return true;
  const status =
    typeof payload.status === "string" ? payload.status.toLowerCase() : "";
  return status === "error";
}

/**
 * Extract a human-readable summary string from an OpenClaw agent result
 * payload.  Returns `null` when no summary text can be determined.
 */
export function extractSummary(payload: Record<string, unknown>): string | null {
  // The gateway puts a short description in `summary`
  if (typeof payload.summary === "string" && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }
  // Fallback: look inside a nested `result` object for a text/summary field
  if (
    typeof payload.result === "object" &&
    payload.result !== null &&
    !Array.isArray(payload.result)
  ) {
    const inner = payload.result as Record<string, unknown>;
    if (typeof inner.summary === "string" && inner.summary.trim().length > 0) {
      return inner.summary.trim();
    }
    if (typeof inner.text === "string" && inner.text.trim().length > 0) {
      return inner.text.trim();
    }
  }
  return null;
}

/**
 * Attempt to parse arbitrary text as a JSON object.  Returns `null` for
 * non-object / unparseable input.  Retained for backward compatibility with
 * code that imports this helper.
 */
export function parseOpenClawResponse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
