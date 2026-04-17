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

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatTimeoutPolicySource(value: string | null) {
  switch (value) {
    case "dual_fields":
      return "dual timeout fields";
    case "dual_stall_plus_legacy_absolute":
      return "dual stall field plus legacy `timeoutSec` absolute ceiling";
    case "legacy_timeoutSec":
      return "legacy `timeoutSec` compatibility";
    default:
      return "unspecified";
  }
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

  return Object.keys(summary).length > 0 ? summary : null;
}

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  const timeoutTermination = readRecord(resultJson.timeoutTermination);
  if (timeoutTermination) {
    const reason = readCommentText(timeoutTermination.reason) ?? "timeout";
    const runId = readCommentText(timeoutTermination.runId) ?? "unknown";
    const startedAt = readCommentText(timeoutTermination.startedAt) ?? "unknown";
    const lastActivityAt = timeoutTermination.lastActivityAt == null
      ? "null"
      : (readCommentText(timeoutTermination.lastActivityAt) ?? "null");
    const thresholdKey = readCommentText(timeoutTermination.firedThresholdKey) ?? "timeout";
    const thresholdSec =
      typeof timeoutTermination.firedThresholdSec === "number"
        ? timeoutTermination.firedThresholdSec
        : null;
    const stallThresholdSec =
      typeof timeoutTermination.stallThresholdSec === "number"
        ? timeoutTermination.stallThresholdSec
        : null;
    const absoluteTimeoutSec =
      typeof timeoutTermination.absoluteTimeoutSec === "number"
        ? timeoutTermination.absoluteTimeoutSec
        : null;
    const telemetryFallback = timeoutTermination.telemetryFallback === true;
    const stallExceeded = timeoutTermination.stallExceeded === true;
    const policySource = formatTimeoutPolicySource(readCommentText(timeoutTermination.policySource));
    const summary = readCommentText(resultJson.summary)
      ?? (reason === "stall"
        ? "Run timed out on stall policy."
        : "Run timed out on absolute ceiling policy.");

    const lines = [
      "## Timeout incident",
      "",
      summary,
      "",
      `- terminal reason: \`${reason}\``,
      `- run id: \`${runId}\``,
      `- startedAt: \`${startedAt}\``,
      `- lastActivityAt: \`${lastActivityAt}\` (server-observed activity persisted on the run; \`null\` means telemetry fallback/no qualifying activity)`,
      `- fired threshold: \`${thresholdKey}${thresholdSec != null ? `=${thresholdSec}s` : ""}\``,
      `- policy source: ${policySource}`,
      `- configured stall threshold: ${stallThresholdSec != null ? `\`stallTimeoutSec=${stallThresholdSec}s\`` : "`disabled`"}`,
      `- configured absolute ceiling: ${absoluteTimeoutSec != null ? `\`absoluteTimeoutSec=${absoluteTimeoutSec}s\`` : "`disabled`"}`,
      `- telemetry fallback: ${telemetryFallback ? "`true` — stall enforcement was skipped because no qualifying server-observed activity was available." : "`false`"}`,
      `- stall exceeded at enforcement time: \`${stallExceeded}\``,
    ];
    return lines.join("\n");
  }

  return (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
}
