import type { TranscriptEntry } from "@paperclipai/adapter-utils";

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

/**
 * Parse a single stdout line from Copilot CLI JSONL output into TranscriptEntry[].
 *
 * Copilot CLI v1.0.24 envelope format:
 * ```json
 * {"type":"assistant.message_delta","data":{"messageId":"...","deltaContent":"hello"},"id":"...","timestamp":"...","ephemeral":true}
 * ```
 *
 * NOTE: A single stdout chunk from `runChildProcess` may contain multiple
 * newline-separated JSONL lines (buffer boundary misalignment). The caller
 * should split on `\n` and call this function for each sub-line. This function
 * handles a single line only.
 */
export function parseCopilotLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Handle multi-line chunks: split and recurse
  if (line.includes("\n")) {
    const results: TranscriptEntry[] = [];
    for (const subLine of line.split("\n")) {
      const trimmed = subLine.trim();
      if (trimmed) {
        results.push(...parseCopilotLocalStdoutLine(trimmed, ts));
      }
    }
    return results;
  }

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  // Unwrap data envelope — most Copilot CLI events nest payload under `data`
  const data = asRecord(parsed.data) ?? {};

  // --- assistant.message_delta: streaming text chunk ---
  if (type === "assistant.message_delta") {
    const content = asString(data.deltaContent);
    if (!content) return [];
    return [{ kind: "assistant", ts, text: content, delta: true }];
  }

  // --- assistant.message: complete message + tool calls ---
  if (type === "assistant.message") {
    const entries: TranscriptEntry[] = [];
    const content = asString(data.content);
    if (content) {
      entries.push({ kind: "assistant", ts, text: content });
    }

    // Extract tool calls from toolRequests array (inside data envelope)
    // Copilot CLI format: { toolCallId, name, arguments, type, intentionSummary }
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const reqRaw of toolRequests) {
      const req = asRecord(reqRaw);
      if (!req) continue;
      const toolName = asString(req.name) || asString(req.toolName) || "unknown";
      const toolUseId = asString(req.toolCallId) || asString(req.id) || undefined;
      const input = req.arguments ?? req.input ?? {};
      entries.push({
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId,
        input,
      });
    }

    return entries.length > 0 ? entries : [];
  }

  // --- assistant.reasoning: reasoning block (often encrypted/opaque) ---
  if (type === "assistant.reasoning") {
    const content = asString(data.content);
    if (!content) return [];
    // Skip if content looks encrypted/opaque (base64-like, no spaces, very long)
    if (content.length > 100 && !content.includes(" ")) return [];
    return [{ kind: "thinking", ts, text: content }];
  }

  // --- assistant.reasoning_delta: streaming reasoning chunk ---
  if (type === "assistant.reasoning_delta") {
    const content = asString(data.deltaContent) || asString(data.content);
    if (!content) return [];
    if (content.length > 100 && !content.includes(" ")) return [];
    return [{ kind: "thinking", ts, text: content, delta: true }];
  }

  // --- tool.execution_start: intentionally empty (dedup fix) ---
  if (type === "tool.execution_start") {
    return [];
  }

  // --- tool.execution_complete: tool result ---
  // Copilot CLI format: data.toolCallId, data.success (bool),
  //   data.result.content / data.result.detailedContent (on success),
  //   data.error.message / data.error.code (on failure),
  //   data.model, data.toolTelemetry
  // NOTE: toolName is NOT present on complete events — must correlate via toolCallId
  if (type === "tool.execution_complete") {
    const toolUseId = asString(data.toolCallId) || asString(data.toolUseId) || asString(data.id, "tool");
    const toolName = asString(data.toolName) || undefined;
    const isError = data.success === false;
    let output = "";
    if (isError) {
      const errObj = asRecord(data.error);
      output = errObj ? asString(errObj.message) || asString(errObj.code) : "";
    } else {
      const resultObj = asRecord(data.result);
      output = resultObj
        ? asString(resultObj.detailedContent) || asString(resultObj.content)
        : asString(data.output) || asString(data.content) || "";
    }
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content: output,
      isError,
    }];
  }

  // --- tool.execution_partial_result: streaming tool output ---
  if (type === "tool.execution_partial_result") {
    const toolUseId = asString(data.toolCallId) || asString(data.toolUseId) || asString(data.id, "tool");
    const toolName = asString(data.toolName) || undefined;
    const resultObj = asRecord(data.result);
    const output = resultObj
      ? asString(resultObj.detailedContent) || asString(resultObj.content)
      : asString(data.output) || asString(data.content) || "";
    const isError = data.success === false;
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      toolName,
      content: output,
      isError,
    }];
  }

  // --- result: final summary with session and usage ---
  if (type === "result") {
    // sessionId is top-level on result events (not inside data)
    const sessionId = asString(parsed.sessionId, "");
    // usage is also top-level
    const usageObj = asRecord(parsed.usage) ?? {};
    const premiumRequests = asNumber(usageObj.premiumRequests, 0);
    const sessionDurationMs = asNumber(usageObj.sessionDurationMs, 0);
    const codeChanges = asRecord(usageObj.codeChanges);
    const linesAdded = codeChanges ? asNumber(codeChanges.linesAdded, 0) : 0;
    const linesRemoved = codeChanges ? asNumber(codeChanges.linesRemoved, 0) : 0;

    const parts: string[] = [];
    if (sessionId) parts.push(`session: ${sessionId}`);
    if (premiumRequests) parts.push(`premium: ${premiumRequests}`);
    if (sessionDurationMs) parts.push(`duration: ${Math.round(sessionDurationMs / 1000)}s`);
    if (linesAdded || linesRemoved) parts.push(`changes: +${linesAdded}/-${linesRemoved}`);
    const text = parts.length > 0 ? parts.join(", ") : "completed";

    return [{
      kind: "result",
      ts,
      text,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "result",
      isError: false,
      errors: [],
    }];
  }

  // --- assistant.turn_start: system marker ---
  if (type === "assistant.turn_start") {
    const turnId = asString(data.turnId, "");
    return [{ kind: "system", ts, text: `turn ${turnId} started` }];
  }

  // --- assistant.turn_end: system marker ---
  if (type === "assistant.turn_end") {
    const turnId = asString(data.turnId, "");
    return [{ kind: "system", ts, text: `turn ${turnId} ended` }];
  }

  // --- session.* events: skip (ephemeral setup) ---
  if (type.startsWith("session.")) {
    return [];
  }

  // --- user.message: skip (echo of prompt) ---
  if (type === "user.message") {
    return [];
  }

  // --- assistant.intent / assistant.usage: skip ---
  if (type === "assistant.intent" || type === "assistant.usage") {
    return [];
  }

  // --- error: surface as stderr ---
  if (type === "error") {
    const msg = asString(data.message, "") || asString(parsed.message, "");
    const errObj = asRecord(data.error ?? parsed.error);
    const text = msg || asString(errObj?.message, "") || line;
    return [{ kind: "stderr", ts, text }];
  }

  // Unknown event types: pass through as stdout
  return [{ kind: "stdout", ts, text: line }];
}
