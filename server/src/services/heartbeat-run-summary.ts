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

// Write-side counterpart of heartbeatRunSafeResultJsonColumn. That read guard
// already decided that once result_json passes HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES
// only the first HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS of stdout/stderr are ever
// projected — so anything past that was stored, dumped hourly and never read back.
// Adapters return the whole stream (the full log already goes to the out-of-band
// log store: log_store/log_ref/log_bytes/log_sha256), which is why heartbeat_runs
// grew to 7.9 GB with result_json alone accounting for 7.0 GB of it. Bound it here,
// at the single point where every adapter's result is persisted, rather than in each
// of the dozen adapter execute.ts files where a new adapter would silently regress it.
export function boundHeartbeatRunResultJson(
  resultJson: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  let bounded: Record<string, unknown> | null = null;
  for (const key of ["stdout", "stderr"] as const) {
    const value = resultJson[key];
    if (typeof value !== "string" || value.length <= HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS) {
      continue;
    }
    bounded ??= { ...resultJson };
    // Keep the tail: a failing run says why it failed at the end, not the start.
    bounded[key] = value.slice(value.length - HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS);
    bounded[`${key}Truncated`] = true;
    bounded[`${key}FullChars`] = value.length;
  }

  return bounded ?? resultJson;
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

// The fallback comment is only posted when a run ends without the agent posting
// its own comment via the API. In that case `resultJson.summary` can be raw
// inter-tool narration (assistantTexts concatenated by the adapter), which must
// never be published verbatim to the board — see BRO-1507 / BRO-1516.
export const MAX_FALLBACK_COMMENT_CHARS = 1200;
// Apostrophes are matched as a character class so both the straight (') and
// curly (’) forms count — agents emit either. Openers are narration phrases a
// declarative status summary would not begin with ("Fixed X", "13/13 pass").
const NARRATION_OPENERS =
  /^(let me\b|i['’]ll\b|i['’]m going\b|i need to\b|i can see\b|now i['’]ll\b|next,? i['’]ll\b|looking at\b|fetching\b|checking\b|first,)/i;
const FALLBACK_WITHHELD_COMMENT =
  "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).";

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const text =
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message);
  if (!text) {
    return null;
  }

  if (text.length > MAX_FALLBACK_COMMENT_CHARS || NARRATION_OPENERS.test(text)) {
    return FALLBACK_WITHHELD_COMMENT;
  }

  return text;
}
