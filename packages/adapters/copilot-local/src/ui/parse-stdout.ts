import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a single JSONL line from Copilot CLI `--output-format json` output
 * into zero or more TranscriptEntry items for the UI transcript view.
 *
 * Current (dominant) event schema — Claude Code / Copilot CLI streaming JSON:
 *   { type: "system", subtype: "init", session_id, model, cwd, tools[] }
 *   { type: "assistant", message: { content: Array<TextBlock|ToolUseBlock|ThinkingBlock> } }
 *   { type: "user", message: { content: Array<ToolResultBlock> } }
 *   { type: "result", subtype: "success"|"error", result, session_id, total_cost_usd, usage }
 *   { type: "rate_limit_event", ... }
 *
 * Legacy event schema (older Copilot CLI versions):
 *   { type: "session.tools_updated", data: { model } }
 *   { type: "assistant.message", data: { content } }
 *   { type: "assistant.tool_request", data: { id, name, parameters } }
 *   { type: "tool.result", data: { id, result, isError } }
 *   { type: "result", sessionId, exitCode, usage: { premiumRequests } }
 */
export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  const subtype = asString(parsed.subtype);

  // ── Current format ────────────────────────────────────────────────────────

  // system/init → session init
  if (type === "system" && subtype === "init") {
    const model = asString(parsed.model) || "unknown";
    const sessionId = asString(parsed.session_id);
    return [{ kind: "init", ts, model, sessionId }];
  }

  // assistant → may contain text, tool_use, and/or thinking blocks
  if (type === "assistant") {
    const msg = asRecord(parsed.message);
    if (!msg) return [];
    const entries: TranscriptEntry[] = [];
    for (const block of asArray(msg.content)) {
      const b = asRecord(block);
      if (!b) continue;
      const btype = asString(b.type);
      if (btype === "text") {
        const text = asString(b.text);
        if (text) entries.push({ kind: "assistant", ts, text });
      } else if (btype === "tool_use") {
        const name = asString(b.name) || "unknown";
        const toolUseId = asString(b.id) || undefined;
        entries.push({ kind: "tool_call", ts, name, toolUseId, input: asRecord(b.input) ?? {} });
      }
      // thinking blocks are intentionally omitted — they're internal reasoning
    }
    return entries;
  }

  // user → tool results (feed back to assistant after tool calls)
  if (type === "user") {
    const msg = asRecord(parsed.message);
    if (!msg) return [];
    const entries: TranscriptEntry[] = [];
    for (const block of asArray(msg.content)) {
      const b = asRecord(block);
      if (!b) continue;
      if (asString(b.type) === "tool_result") {
        const toolUseId = asString(b.tool_use_id);
        const isError = b.is_error === true;
        const content = asString(b.content);
        entries.push({ kind: "tool_result", ts, toolUseId, content, isError });
      }
    }
    return entries;
  }

  // result → final summary (both current subtype form and legacy exitCode form)
  if (type === "result") {
    const usageObj = asRecord(parsed.usage) ?? {};
    const sessionId = asString(parsed.session_id) || asString(parsed.sessionId);
    const costUsd = asNumber(parsed.total_cost_usd);
    const inputTokens = asNumber(usageObj.input_tokens);
    const outputTokens = asNumber(usageObj.output_tokens);
    const cachedTokens = asNumber(usageObj.cache_read_input_tokens);

    // current format: is_error flag + result text
    const resultText = asString(parsed.result);
    const isErrorFlag = parsed.is_error === true;
    // legacy format: exitCode
    const exitCode = asNumber(parsed.exitCode);
    const premiumRequests = asNumber((asRecord(parsed.usage) ?? {}).premiumRequests);

    const isError = isErrorFlag || exitCode !== 0;

    const textParts: string[] = [];
    if (resultText) textParts.push(resultText);
    else if (sessionId) textParts.push(`Session: ${sessionId}`);
    if (premiumRequests) textParts.push(`${premiumRequests} premium request${premiumRequests === 1 ? "" : "s"}`);

    return [
      {
        kind: "result",
        ts,
        text: textParts.join(" | "),
        inputTokens,
        outputTokens,
        cachedTokens,
        costUsd,
        subtype: isError ? "error" : "end_turn",
        isError,
        errors: isError && resultText ? [resultText] : isError ? [`exit code ${exitCode}`] : [],
      },
    ];
  }

  // ── Legacy format ─────────────────────────────────────────────────────────

  const data = asRecord(parsed.data);

  if (type === "session.tools_updated" && data) {
    const model = asString(data.model) || "unknown";
    return [{ kind: "init", ts, model, sessionId: "" }];
  }

  if (type === "assistant.message" && data) {
    const text = asString(data.content);
    if (text) return [{ kind: "assistant", ts, text }];
    return [];
  }

  if (type === "assistant.tool_request" && data) {
    const name = asString(data.name) || "unknown";
    const toolUseId = asString(data.id) || undefined;
    return [{ kind: "tool_call", ts, name, toolUseId, input: asRecord(data.parameters) ?? {} }];
  }

  if (type === "tool.result" && data) {
    const toolUseId = asString(data.id);
    const isError = data.isError === true;
    const content = asString(data.result);
    return [{ kind: "tool_result", ts, toolUseId, content, isError }];
  }

  // tool.execution_complete — legacy alternative for tool results
  if (type === "tool.execution_complete" && data) {
    const toolUseId = asString(data.toolCallId);
    const isError = data.success !== true;
    const resultObj = asRecord(data.result);
    const content = resultObj ? asString(resultObj.content) : "";
    return [{ kind: "tool_result", ts, toolUseId, content, isError }];
  }

  // session.error → show the error message
  if (type === "session.error" && data) {
    const message = asString(data.message);
    return message ? [{ kind: "stdout", ts, text: `[error] ${message}` }] : [];
  }

  // Skip noise / deltas that don't belong in the transcript
  if (
    type === "rate_limit_event" ||
    type === "assistant.message_delta" ||
    type === "assistant.reasoning_delta" ||
    type === "assistant.reasoning" ||
    type === "assistant.turn_start" ||
    type === "assistant.turn_end" ||
    type === "session.mcp_server_status_changed" ||
    type === "session.mcp_servers_loaded" ||
    type === "session.background_tasks_changed" ||
    type === "session.info" ||
    type === "tool.execution_start" ||
    type === "tool.execution_partial_result" ||
    type === "user.message"
  ) {
    return [];
  }

  return [{ kind: "stdout", ts, text: line }];
}
