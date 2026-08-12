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

  return Object.keys(summary).length > 0 ? summary : null;
}

const RUN_COMMENT_CANDIDATE_FIELDS = ["summary", "result", "message"] as const;

/**
 * Structural-garbage gate for run summaries that are about to be published as
 * issue comments. It targets torn-stream fragments (a run torn down mid-stream
 * can leave a lone `{` as its whole "summary"), NOT brevity: legitimate short
 * answers such as "Done." or "OK — merged." stay publishable, and there is
 * deliberately no length floor.
 */
export function isPublishableRunSummary(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  // Pure whitespace/punctuation fragments ("{", "}", "[{", "...", "—") carry
  // no publishable content: require at least one letter or digit.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return false;

  // Text that starts like a JSON object/array must actually be complete,
  // parseable JSON. A truncated stream fragment (`{"summary": "par`) fails
  // here; a COMPLETE JSON document is deliberately kept publishable because
  // it is well-formed adapter output rather than torn-stream garbage.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
    } catch {
      return false;
    }
  }

  return true;
}

/**
 * First non-empty trimmed comment candidate (summary/result/message),
 * WITHOUT the publishability gate. Lets callers distinguish "no candidate
 * existed" from "a candidate existed but was rejected as non-publishable".
 */
export function readHeartbeatRunCommentCandidate(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  for (const key of RUN_COMMENT_CANDIDATE_FIELDS) {
    const candidate = readCommentText(resultJson[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  // Fall-through is deliberate: a torn `summary` fragment must not shadow a
  // well-formed `result`/`message` candidate from the same payload.
  for (const key of RUN_COMMENT_CANDIDATE_FIELDS) {
    const candidate = readCommentText(resultJson[key]);
    if (candidate !== null && isPublishableRunSummary(candidate)) {
      return candidate;
    }
  }
  return null;
}
