function truncateSummaryText(value: unknown, maxLength = 500) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readNumericField(record: Record<string, unknown>, key: string) {
  return key in record ? record[key] ?? null : undefined;
}

function readCommentText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = normalizeIssueCommentText(value);
  return trimmed.length > 0 ? trimmed : null;
}

const TRANSCRIPT_NOISE_PATTERNS = [
  /(^|\n)\s*↻\s*Resumed session\b/i,
  /\bDANGEROUS COMMAND\b/i,
  /(^|\n)\s*Choice \[[^\]]+\]:/i,
  /(^|\n)\s*╭─\s*⚕ Hermes\b/i,
] as const;

const TRANSCRIPT_VERDICT_ANCHORS = [
  /(^|\n)\s*DONE:/i,
  /(^|\n)\s*(?:#+\s*)?Smart Review Summary\b/i,
  /(^|\n)\s*(?:#+\s*)?Summary\b/i,
  /(^|\n)\s*(?:#+\s*)?Resolution Summary\b/i,
  /(^|\n)\s*Root cause:/i,
  /(^|\n)\s*\[QA PASS\]/i,
  /(^|\n)\s*\[RELEASE CONFIRMED\]/i,
] as const;

function looksLikeTranscriptNoise(value: string) {
  return TRANSCRIPT_NOISE_PATTERNS.some((pattern) => pattern.test(value));
}

function extractStructuredCommentTail(value: string) {
  if (!looksLikeTranscriptNoise(value)) return value;

  const anchorIndexes = TRANSCRIPT_VERDICT_ANCHORS
    .map((pattern) => value.search(pattern))
    .filter((index) => index >= 0);
  if (anchorIndexes.length === 0) {
    return null;
  }

  const earliestAnchor = Math.min(...anchorIndexes);
  const tail = value.slice(earliestAnchor).trim();
  return tail.length > 0 ? tail : null;
}

function cleanIssueCommentText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const filtered = value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length === 0
        || !/^command:\s+/i.test(trimmed)
          && !/^status:\s+/i.test(trimmed)
          && !/^exit_?code:\s+/i.test(trimmed)
      );
    })
    .join("\n");
  const normalized = readCommentText(filtered);
  if (!normalized) return null;
  const extracted = extractStructuredCommentTail(normalized);
  return extracted ? readCommentText(extracted) : null;
}

function stripTrailingSessionIdLine(value: string) {
  return value.replace(/\n+session_id:\s*\S+\s*$/i, "").trim();
}

const RUN_SUMMARY_LAYOUT_MARKERS = [
  /(^|\n)#{0,3}\s*summary\b/im,
  /(^|\n)#{0,3}\s*status:\s*/im,
] as const;

const RUN_SUMMARY_CONTENT_MARKERS = [
  /(^|\n)#{0,3}\s*acceptance criteria\b/im,
  /(^|\n)#{0,3}\s*files changed\b/im,
  /\bImplementation Complete\b/i,
  /\bNo active parent to notify\b/i,
  /\bdelivery gate requires QA agent\b/i,
] as const;

function collapseAdjacentRepeatedPrefix(value: string) {
  const candidateBoundaries = new Set<number>([value.length]);
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) {
    candidateBoundaries.add(index + 1);
  }

  const orderedBoundaries = [...candidateBoundaries].sort((left, right) => right - left);
  for (const boundary of orderedBoundaries) {
    if (boundary < 200) continue;

    const prefix = value.slice(0, boundary);
    if (!value.startsWith(prefix, boundary)) continue;

    const nonEmptyLineCount = prefix
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .length;
    if (nonEmptyLineCount < 4) continue;

    return `${prefix}${value.slice(boundary * 2)}`.trim();
  }

  return value;
}

function collapseRepeatedContent(value: string) {
  let current = value;
  while (true) {
    const collapsed = collapseAdjacentRepeatedPrefix(current);
    if (collapsed === current) return current;
    current = collapsed;
  }
}

export function normalizeIssueCommentText(value: string) {
  return collapseRepeatedContent(stripTrailingSessionIdLine(value.replace(/\r\n?/g, "\n").trim()));
}

export function isLikelySynthesizedRunSummaryText(value: string) {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (normalized.length === 0) return false;
  if (!RUN_SUMMARY_LAYOUT_MARKERS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return RUN_SUMMARY_CONTENT_MARKERS.some((pattern) => pattern.test(normalized));
}

export function normalizeRunLinkedIssueCommentBody(input: {
  body: string;
  authorAgentId?: string | null;
  createdByRunId?: string | null;
}) {
  if (!input.authorAgentId || !input.createdByRunId) {
    return input.body;
  }
  if (!isLikelySynthesizedRunSummaryText(input.body)) {
    return input.body;
  }
  return normalizeIssueCommentText(input.body);
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
  opts: { hasExistingRunComment?: boolean } = {},
): string | null {
  if (opts.hasExistingRunComment) {
    return null;
  }
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) {
    return null;
  }

  return (
    cleanIssueCommentText(resultJson.summary)
    ?? cleanIssueCommentText(resultJson.result)
    ?? cleanIssueCommentText(resultJson.message)
    ?? null
  );
}
