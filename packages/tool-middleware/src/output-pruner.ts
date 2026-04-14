/**
 * ToolOutputPruner — intercepts tool return values and produces a
 * schema-constrained summary before context assembly.
 *
 * Pruning rules (applied in order):
 *   1. Valid JSON → apply tool-specific filter → populate `parsed`
 *   2. jq-equivalent fails → apply regex extraction for known error signatures
 *   3. No regex matches → head + tail truncation
 *   4. Hard ceiling: summary object must not exceed maxOutputBytes (default 1,500)
 */

import { storeArtifact } from "./artifact-store.js";
import { applyToolFilter } from "./tool-filters.js";
import type { ArtifactRef, ToolResultSummary, ToolMiddlewareConfig } from "./types.js";

const ERROR_SIGNATURE_RE =
  /(?:ERROR|FATAL|Exception|Traceback \(most recent call last\)|exit code\s+\d+|FAILED|OOMKilled|panic:|Segmentation fault|command not found|Permission denied|No such file or directory)/i;

const MAX_PREVIEW_CHARS = 200;
const HEAD_LINES = 10;
const TAIL_LINES = 40;

/**
 * Extract first N + last M lines from a multi-line string.
 * Returns the combined excerpt plus a truncation header if lines were dropped.
 */
function headTailExcerpt(text: string, headLines: number, tailLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines) return text;

  const dropped = lines.length - headLines - tailLines;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);
  return [
    `[TRUNCATED: ${dropped} lines, ${Buffer.byteLength(text, "utf8")} bytes]`,
    ...head,
    "...",
    ...tail,
  ].join("\n");
}

/** Estimate token count — rough approximation: 1 token ≈ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract error signatures from output using regex. */
function extractErrorSignatures(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  const matched = lines.filter((line) => ERROR_SIGNATURE_RE.test(line));
  if (matched.length === 0) return null;
  return { errorSignatures: matched.slice(0, 20) };
}

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Extract the command string from a Bash tool input. */
function extractCommand(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === "Bash" || toolName === "bash" || toolName === "shell") {
    return typeof toolInput.command === "string" ? toolInput.command : "";
  }
  return "";
}

/** Extract string output from a tool response. */
function extractOutputString(toolResponse: unknown): string {
  if (typeof toolResponse === "string") return toolResponse;
  if (typeof toolResponse === "object" && toolResponse !== null) {
    const r = toolResponse as Record<string, unknown>;
    // Claude Code tool_result format
    if (typeof r.content === "string") return r.content;
    if (typeof r.output === "string") return r.output;
    if (typeof r.stdout === "string") return r.stdout;
    return JSON.stringify(toolResponse);
  }
  return String(toolResponse ?? "");
}

/** Extract exit code from a tool response. */
function extractExitCode(toolResponse: unknown): number {
  if (typeof toolResponse === "object" && toolResponse !== null) {
    const r = toolResponse as Record<string, unknown>;
    if (typeof r.exit_code === "number") return r.exit_code;
    if (typeof r.exitCode === "number") return r.exitCode;
  }
  return 0;
}

export interface PruneResult {
  summary: ToolResultSummary;
  stdoutRef: ArtifactRef;
  stderrRef: ArtifactRef;
}

/**
 * Prune a tool's output into a schema-constrained summary.
 * Stores full output as artifacts and returns the pruned summary.
 */
export async function pruneToolOutput(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  durationMs: number,
  config: Pick<ToolMiddlewareConfig, "artifactsDir" | "maxOutputBytes" | "maxOutputTokens">,
): Promise<PruneResult> {
  const outputStr = extractOutputString(toolResponse);
  const exitCode = extractExitCode(toolResponse);
  const command = extractCommand(toolName, toolInput);

  // Store full output as artifact (includes secret redaction)
  const [stdoutRef, stderrRef] = await Promise.all([
    storeArtifact(outputStr, config.artifactsDir),
    storeArtifact("", config.artifactsDir), // stderr not available separately from hook
  ]);

  const originalBytes = Buffer.byteLength(outputStr, "utf8");
  const originalLines = outputStr.split("\n").length;
  const status: "success" | "error" = exitCode !== 0 ? "error" : "success";

  let parsed: Record<string, unknown> | null = null;
  let preview = "";
  let truncationFlag = false;

  // Rule 1: Try JSON parse + tool-specific filter
  const jsonParsed = tryParseJson(outputStr);
  if (jsonParsed !== null) {
    parsed = applyToolFilter(toolName, command, jsonParsed);
    if (parsed === null) {
      // No tool-specific filter — use a trimmed JSON preview
      const brief = JSON.stringify(jsonParsed, null, 0);
      preview = brief.slice(0, MAX_PREVIEW_CHARS);
    }
  }

  // Rule 2: Regex extraction for error signatures
  if (parsed === null) {
    parsed = extractErrorSignatures(outputStr);
  }

  // Rule 3: Head + tail truncation for preview
  if (preview === "") {
    const excerpt = headTailExcerpt(outputStr, HEAD_LINES, TAIL_LINES);
    preview = excerpt.slice(0, MAX_PREVIEW_CHARS);
    truncationFlag = originalLines > HEAD_LINES + TAIL_LINES;
  }

  // Rule 4: Hard ceiling — ensure summary doesn't exceed maxOutputBytes / maxOutputTokens
  const summary: ToolResultSummary = {
    tool: toolName,
    status,
    exit_code: exitCode,
    duration_ms: durationMs,
    stdout_ref: stdoutRef.uri,
    stderr_ref: stderrRef.uri,
    preview,
    parsed,
    truncation_flag: truncationFlag,
    original_bytes: originalBytes,
    original_lines: originalLines,
  };

  const summaryJson = JSON.stringify(summary);
  const summaryBytes = Buffer.byteLength(summaryJson, "utf8");
  const summaryTokens = estimateTokens(summaryJson);

  if (summaryBytes > config.maxOutputBytes || summaryTokens > config.maxOutputTokens) {
    // Reduce to minimal: just the first 500 bytes of preview, drop parsed
    summary.preview = outputStr.slice(0, 500);
    summary.parsed = null;
    summary.truncation_flag = true;
  }

  return { summary, stdoutRef, stderrRef };
}

/** Format a ToolResultSummary for injection into Claude's context as hook output. */
export function formatSummaryForContext(summary: ToolResultSummary): string {
  return `[tool-middleware]\n${JSON.stringify(summary, null, 2)}`;
}
