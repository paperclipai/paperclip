export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;

function truncateSummaryText(value: unknown, maxLength = HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
  summary: string | null | undefined,
): Record<string, unknown> | null {
  const normalizedSummary = readCommentText(summary);
  const baseResult =
    resultJson && typeof resultJson === "object" && !Array.isArray(resultJson)
      ? resultJson
      : null;

  if (!baseResult) {
    return normalizedSummary ? { summary: normalizedSummary } : null;
  }

  if (!normalizedSummary) {
    return baseResult;
  }

  if (readCommentText(baseResult.summary)) {
    return baseResult;
  }

  return {
    ...baseResult,
    summary: normalizedSummary,
  };
}

function classifyErrorText(text: string): string {
  const lower = text.toLowerCase();
  if (/\brate.?limit|429|too.?many.?requests|throttl/i.test(lower)) return "rate_limit";
  if (/\boverloaded|503|529|service.?unavailable/i.test(lower)) return "overloaded";
  if (/\bauth|unauthorized|401|login.?required/i.test(lower)) return "authentication";
  if (/\bpermission|forbidden|403/i.test(lower)) return "permission";
  if (/\btimeout|timed.?out/i.test(lower)) return "timeout";
  if (/\bmax.?turn|turn.?limit/i.test(lower)) return "max_turns";
  if (/\bnot.?found|404/i.test(lower)) return "not_found";
  if (/\bprocess.?lost|child.?died|killed|signal/i.test(lower)) return "process_lost";
  return "unknown";
}

function buildErrorCategoryCounts(
  resultJson: Record<string, unknown>,
): Record<string, number> | null {
  const counts: Record<string, number> = {};

  const errors = resultJson.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const category =
          readCommentText((entry as Record<string, unknown>).type) ??
          readCommentText((entry as Record<string, unknown>).category) ??
          "unknown";
        counts[category] = (counts[category] ?? 0) + 1;
      } else if (typeof entry === "string" && entry.trim().length > 0) {
        const category = classifyErrorText(entry);
        counts[category] = (counts[category] ?? 0) + 1;
      }
    }
  }

  const errorFamily = readCommentText(resultJson.errorFamily);
  if (errorFamily) {
    counts[errorFamily] = (counts[errorFamily] ?? 0) + 1;
  }

  return Object.keys(counts).length > 0 ? counts : null;
}

export function summarizeHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const summary: Record<string, unknown> = {};

  const textFields = ["summary", "result", "message", "error"] as const;
  for (const key of textFields) {
    const value = truncateSummaryText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  const numericFieldAliases = ["total_cost_usd", "cost_usd", "costUsd"] as const;
  for (const key of numericFieldAliases) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["stopReason", "timeoutSource"] as const) {
    const value = readCommentText(resultJson[key]);
    if (value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["effectiveTimeoutSec", "effectiveTimeoutMs"] as const) {
    const value = readNumericField(resultJson, key);
    if (value !== undefined && value !== null) {
      summary[key] = value;
    }
  }

  for (const key of ["timeoutConfigured", "timeoutFired"] as const) {
    if (typeof resultJson[key] === "boolean") {
      summary[key] = resultJson[key];
    }
  }

  const errorCategoryCounts = buildErrorCategoryCounts(resultJson);
  if (errorCategoryCounts && Object.keys(errorCategoryCounts).length > 0) {
    summary.error_category_counts = errorCategoryCounts;
  }

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }
  return (
    readCommentText(resultJson.summary) ??
    readCommentText(resultJson.result) ??
    readCommentText(resultJson.message) ??
    null
  );
}
