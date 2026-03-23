import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseJson } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parse Copilot CLI JSONL output (--output-format json).
 *
 * Each line is a standalone JSON object with a `type` field.
 * Key event types:
 *   session.tools_updated  → model info
 *   assistant.message      → text content, tool requests, output tokens
 *   tool.execution_start   → tool invocation
 *   tool.execution_complete→ tool result
 *   result                 → terminal event with sessionId, exitCode, usage
 */
export function parseCopilotJsonl(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  let totalOutputTokens = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};

    if (type === "session.tools_updated") {
      model = asString(data.model, model);
      continue;
    }

    if (type === "assistant.message") {
      const content = asString(data.content, "");
      if (content) assistantTexts.push(content);
      totalOutputTokens += asNumber(data.outputTokens, 0);
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.sessionId, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj =
    typeof finalResult.usage === "object" &&
    finalResult.usage !== null &&
    !Array.isArray(finalResult.usage)
      ? (finalResult.usage as Record<string, unknown>)
      : {};

  // Copilot CLI reports premiumRequests and timing but not standard token counts.
  // We aggregate outputTokens from assistant.message events.
  const usage: UsageSummary = {
    inputTokens: 0,
    outputTokens: totalOutputTokens,
    cachedInputTokens: 0,
  };

  const summary = assistantTexts.join("\n\n").trim();
  const premiumRequests = asNumber(usageObj.premiumRequests, 0);

  return {
    sessionId,
    model,
    costUsd: null as number | null,
    usage,
    summary,
    resultJson: finalResult,
    premiumRequests,
  };
}

/**
 * Describe a Copilot CLI failure from the result event.
 */
export function describeCopilotFailure(result: Record<string, unknown>): string | null {
  const exitCode = asNumber(result.exitCode, -1);
  if (exitCode === 0) return null;
  return `Copilot CLI exited with code ${exitCode}`;
}

const AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|login\s+required|requires\s+login|unauthorized|authentication\s+required|copilot\s+login)/i;

/**
 * Detect whether the Copilot CLI output indicates an authentication problem.
 */
export function detectCopilotLoginRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean } {
  const combined = [input.stdout, input.stderr].join("\n");
  return { requiresLogin: AUTH_REQUIRED_RE.test(combined) };
}

/**
 * Check if the failure is due to a max autopilot continues limit.
 */
export function isCopilotMaxTurnsResult(result: Record<string, unknown>): boolean {
  // Copilot CLI doesn't have a specific max-turns error subtype yet.
  // We inspect the result for relevant patterns.
  const resultStr = JSON.stringify(result).toLowerCase();
  return /max.*auto.*pilot|auto.*pilot.*limit/i.test(resultStr);
}

/**
 * Check if the failure is due to an unknown or expired session ID.
 * When --resume is passed with a session that no longer exists, Copilot CLI
 * emits an error containing session-not-found language.
 */
export function isCopilotUnknownSessionError(result: Record<string, unknown>): boolean {
  const resultStr = JSON.stringify(result).toLowerCase();
  return /unknown.*session|session.*not found|session.*expired|invalid.*session|session.*invalid/i.test(resultStr);
}

/**
 * A loggable entry produced by interpreting a Copilot CLI JSONL line.
 */
export interface JsonlLogEntry {
  stream: "stdout";
  text: string;
}

/**
 * Map a single raw JSONL line from Copilot CLI (--output-format json) to zero
 * or more log entries that should be forwarded to the Paperclip run log.
 *
 * Emits:
 *   assistant.message_delta → data.deltaContent text (streaming, real-time)
 *   assistant.message       → data.content text (only when no deltas were seen for this message)
 *   tool.execution_start    → "[toolName]\n" using data.toolName (or data.tool as fallback)
 *
 * All other event types, empty lines, non-JSON input, and non-object JSON
 * (nulls, arrays, primitives) are silently suppressed → returns [].
 */
export function mapCopilotJsonlLineToLog(line: string, seenDeltaMessageIds?: Set<string>): JsonlLogEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};

    if (type === "assistant.message_delta") {
      const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
      if (!deltaContent) return [];
      const messageId = typeof data.messageId === "string" ? data.messageId : "";
      if (messageId && seenDeltaMessageIds) seenDeltaMessageIds.add(messageId);
      return [{ stream: "stdout", text: deltaContent }];
    }

    if (type === "assistant.message") {
      const messageId = typeof data.messageId === "string" ? data.messageId : "";
      // If we already streamed deltas for this messageId, suppress the full content
      // to avoid duplication. Emit a newline to terminate the streamed block.
      if (messageId && seenDeltaMessageIds?.has(messageId)) {
        return [{ stream: "stdout", text: "\n" }];
      }
      const content = typeof data.content === "string" ? data.content : "";
      return content ? [{ stream: "stdout", text: content + "\n" }] : [];
    }

    if (type === "tool.execution_start") {
      const toolName =
        typeof data.toolName === "string" ? data.toolName :
        typeof data.tool === "string" ? data.tool :
        "tool";
      return [{ stream: "stdout", text: `[${toolName}]\n` }];
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Strip YAML frontmatter (the leading `--- ... ---` block) from a skill
 * markdown file, returning the trimmed body text.  Returns an empty string
 * if the body is empty or the input is empty.
 */
export function stripSkillFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n?/, "").trim();
}
