/**
 * Format Copilot CLI JSONL events for CLI (non-interactive) transcript display.
 *
 * Copilot CLI v1.0.24 envelope format:
 * `{"type":"...","data":{...},"id":"...","timestamp":"...","ephemeral":true/false}`
 */

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface FormatCopilotLocalEventResult {
  type: "text" | "tool_call" | "tool_result" | "system" | "error" | "result" | "thinking" | "skip";
  content: string;
}

/**
 * Format a single stdout line/chunk from Copilot CLI into a display-friendly result.
 *
 * Handles multi-line chunks (buffer boundary splits) by returning only
 * the first meaningful event — CLI display is best-effort streaming.
 */
export function formatCopilotLocalEvent(rawLine: string): FormatCopilotLocalEventResult {
  // Handle multi-line chunks: process each line, return first meaningful one
  if (rawLine.includes("\n")) {
    for (const subLine of rawLine.split("\n")) {
      const trimmed = subLine.trim();
      if (!trimmed) continue;
      const result = formatCopilotLocalEvent(trimmed);
      if (result.type !== "skip") return result;
    }
    return { type: "skip", content: "" };
  }

  const parsed = asRecord(safeJsonParse(rawLine));
  if (!parsed) {
    return { type: "text", content: rawLine };
  }

  const type = asString(parsed.type);
  const data = asRecord(parsed.data) ?? {};

  // --- assistant.message_delta: streaming text ---
  if (type === "assistant.message_delta") {
    const content = asString(data.deltaContent);
    return content ? { type: "text", content } : { type: "skip", content: "" };
  }

  // --- assistant.message: complete message ---
  if (type === "assistant.message") {
    const content = asString(data.content);
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];

    const parts: string[] = [];
    if (content) parts.push(content);

    for (const reqRaw of toolRequests) {
      const req = asRecord(reqRaw);
      if (!req) continue;
      const toolName = asString(req.name) || asString(req.toolName) || "unknown";
      parts.push(`[tool_call: ${toolName}]`);
    }

    return parts.length > 0
      ? { type: toolRequests.length > 0 ? "tool_call" : "text", content: parts.join("\n") }
      : { type: "skip", content: "" };
  }

  // --- assistant.reasoning / assistant.reasoning_delta ---
  if (type === "assistant.reasoning" || type === "assistant.reasoning_delta") {
    const content = asString(data.content) || asString(data.deltaContent);
    if (!content) return { type: "skip", content: "" };
    // Skip encrypted/opaque reasoning
    if (content.length > 100 && !content.includes(" ")) return { type: "skip", content: "" };
    return { type: "thinking", content };
  }

  // --- tool.execution_complete ---
  // Copilot CLI format: data.toolCallId, data.success (bool),
  //   data.result.content / data.result.detailedContent (on success),
  //   data.error.message / data.error.code (on failure)
  if (type === "tool.execution_complete") {
    const toolName = asString(data.toolName, "tool");
    const isError = data.success === false;
    let output = "";
    if (isError) {
      const errObj = asRecord(data.error);
      output = errObj ? asString(errObj.message) || asString(errObj.code) : "";
    } else {
      const resultObj = asRecord(data.result);
      output = resultObj
        ? asString(resultObj.detailedContent) || asString(resultObj.content)
        : asString(data.output) || asString(data.content, "");
    }
    const prefix = isError ? `[tool_error: ${toolName}]` : `[tool_result: ${toolName}]`;
    return { type: isError ? "error" : "tool_result", content: `${prefix} ${output}`.trim() };
  }

  // --- tool.execution_start: emit tool name + arguments for CLI visibility ---
  if (type === "tool.execution_start") {
    const toolName = asString(data.toolName, "tool");
    const args = asRecord(data.arguments);
    const argStr = args ? JSON.stringify(args) : "";
    return { type: "tool_call", content: `[tool: ${toolName}] ${argStr}`.trim() };
  }

  // --- tool.execution_partial_result: skip ---
  if (type === "tool.execution_partial_result") {
    return { type: "skip", content: "" };
  }

  // --- result: final summary ---
  if (type === "result") {
    const exitCode = asNumber(parsed.exitCode, 0);
    const usageObj = asRecord(parsed.usage) ?? {};
    const premiumReq = asNumber(usageObj.premiumRequests, 0);
    const durationMs = asNumber(usageObj.sessionDurationMs, 0);
    const codeChanges = asRecord(usageObj.codeChanges);
    const linesAdded = codeChanges ? asNumber(codeChanges.linesAdded, 0) : 0;
    const linesRemoved = codeChanges ? asNumber(codeChanges.linesRemoved, 0) : 0;

    const parts: string[] = [`exit: ${exitCode}`];
    if (premiumReq) parts.push(`premium: ${premiumReq}`);
    if (durationMs) parts.push(`duration: ${Math.round(durationMs / 1000)}s`);
    if (linesAdded || linesRemoved) parts.push(`changes: +${linesAdded}/-${linesRemoved}`);

    return { type: "result", content: parts.join(", ") };
  }

  // --- error ---
  if (type === "error") {
    const msg = asString(data.message, "") || asString(parsed.message, "");
    const errObj = asRecord(data.error ?? parsed.error);
    const text = msg || asString(errObj?.message, "") || rawLine;
    return { type: "error", content: text };
  }

  // --- assistant.turn_start / assistant.turn_end ---
  if (type === "assistant.turn_start" || type === "assistant.turn_end") {
    return { type: "system", content: type.replace("assistant.", "") };
  }

  // --- Ephemeral session/setup events: skip ---
  if (type.startsWith("session.") || type === "user.message" || type === "assistant.intent" || type === "assistant.usage") {
    return { type: "skip", content: "" };
  }

  // Unknown: pass through
  return { type: "text", content: rawLine };
}
