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
// Appended to a summary the agent really did write, when only its length was the problem.
// It must read as an elision, never as an error — the run succeeded and the text is genuine.
const TRUNCATION_MARKER =
  "_(summary truncated at the comment length limit — see the run log for the full text.)_";

/**
 * Cut to at most `limit` characters, preferring the last line or word break in the final
 * fifth of the budget. A cut through the middle of a word reads as corruption rather than
 * as an elision, which invites the reader to distrust the part that did survive.
 */
function truncateToBoundary(text: string, limit: number): string {
  const head = text.slice(0, limit);
  const earliestBreak = Math.floor(limit * 0.8);
  const boundary = Math.max(head.lastIndexOf("\n"), head.lastIndexOf(" "));
  return (boundary >= earliestBreak ? head.slice(0, boundary) : head).trimEnd();
}

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

  // Narration is withheld on content, at any length (BRO-1507 / BRO-1516). Nothing in a
  // stream of inter-tool narration becomes publishable by being shorter.
  if (NARRATION_OPENERS.test(text)) {
    return FALLBACK_WITHHELD_COMMENT;
  }

  // Length is not a content judgement, and BRO-2310 is what it cost to treat it as one.
  // A long declarative status report is what a productive run produces. Discarding it told
  // the board the agent had reported nothing, so the disposition check found nothing, moved
  // the issue to `missing_disposition`, and blocked it on a recovery owner that was the same
  // stalled agent. On BRO-2300 that hid finished work across four runs and five hours.
  //
  // Truncate instead. A status report states its conclusion first, so the head of the message
  // is the part worth keeping; the marker sends the reader to the run log for the remainder.
  if (text.length > MAX_FALLBACK_COMMENT_CHARS) {
    return `${truncateToBoundary(text, MAX_FALLBACK_COMMENT_CHARS)}\n\n${TRUNCATION_MARKER}`;
  }

  return text;
}
