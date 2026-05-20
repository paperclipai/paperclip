export const HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS = 500;
export const HEARTBEAT_RUN_RESULT_OUTPUT_MAX_CHARS = 4_096;
export const HEARTBEAT_RUN_SAFE_RESULT_JSON_MAX_BYTES = 64 * 1024;
const PROCESS_COMMENT_OUTPUT_MAX_CHARS = 240;

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

export function buildHeartbeatRunIssueComment(
  resultJson: Record<string, unknown> | null | undefined,
  options?: {
    adapterType?: string | null;
    outcome?: "succeeded" | "failed" | "timed_out" | "cancelled";
    command?: string | null;
    commandArgs?: string[] | null;
    exitCode?: number | null;
    stdoutExcerpt?: string | null;
    stderrExcerpt?: string | null;
  },
): string | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return buildProcessRunIssueComment(options);
  }

  const summaryComment = (
    readCommentText(resultJson.summary)
    ?? readCommentText(resultJson.result)
    ?? readCommentText(resultJson.message)
    ?? null
  );
  if (summaryComment) return summaryComment;
  return buildProcessRunIssueComment(options);
}

function formatProcessOutput(value: string | null | undefined) {
  if (typeof value !== "string") return "_(empty)_";
  const trimmed = value.trim();
  if (!trimmed) return "_(empty)_";
  if (trimmed.length <= PROCESS_COMMENT_OUTPUT_MAX_CHARS) return `\`${trimmed}\``;
  return `\`${trimmed.slice(0, PROCESS_COMMENT_OUTPUT_MAX_CHARS)}...\``;
}

function buildProcessRunIssueComment(
  options:
    | {
      adapterType?: string | null;
      outcome?: "succeeded" | "failed" | "timed_out" | "cancelled";
      command?: string | null;
      commandArgs?: string[] | null;
      exitCode?: number | null;
      stdoutExcerpt?: string | null;
      stderrExcerpt?: string | null;
    }
    | undefined,
) {
  if (!options || options.adapterType !== "process" || !options.outcome) return null;
  const command = (options.command ?? "").trim();
  const args = (options.commandArgs ?? []).map((part) => part.trim()).filter((part) => part.length > 0);
  const commandText = command ? [command, ...args].join(" ") : "_(unavailable)_";
  const exitCodeText = options.exitCode == null ? "_(none)_" : String(options.exitCode);
  return [
    `Process run ${options.outcome}.`,
    "",
    `- Command: \`${commandText}\``,
    `- Exit code: \`${exitCodeText}\``,
    `- Stdout: ${formatProcessOutput(options.stdoutExcerpt)}`,
    `- Stderr: ${formatProcessOutput(options.stderrExcerpt)}`,
  ].join("\n");
}
