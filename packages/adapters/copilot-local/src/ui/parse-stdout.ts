import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a single Copilot CLI JSONL line into TranscriptEntry[].
 *
 * Real Copilot JSONL event structures (verified against CLI 1.0.12):
 *
 * - session.tools_updated:        { data: { model } }
 * - user.message:                 { data: { content } }
 * - assistant.message:            { data: { content, toolRequests: [{ toolCallId, name, arguments, type }], outputTokens } }
 * - assistant.message_delta:      { data: { deltaContent } }
 * - assistant.reasoning:          { data: { reasoningText } }   (ephemeral)
 * - assistant.reasoning_delta:    { data: { deltaContent } }    (ephemeral)
 * - tool.execution_start:         { data: { toolCallId, toolName, arguments } }
 * - tool.execution_complete:      { data: { toolCallId, toolName?, success, result?: { content }, error?: { message, code } } }
 * - result:                       { sessionId, exitCode, usage: { premiumRequests, totalApiDurationMs, sessionDurationMs } }
 *
 * Error cases produce zero JSONL (errors go to stderr as plain text).
 */
export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data) ?? {};

  // Init event — model detected from session.tools_updated
  if (type === "session.tools_updated") {
    const model = typeof data.model === "string" ? data.model : "unknown";
    return [{ kind: "init", ts, model, sessionId: "" }];
  }

  // User message
  if (type === "user.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) return [{ kind: "user", ts, text: content }];
    return [{ kind: "stdout", ts, text: line }];
  }

  // Assistant reasoning (thinking)
  if (type === "assistant.reasoning") {
    const text = typeof data.reasoningText === "string" ? data.reasoningText : "";
    if (text) return [{ kind: "thinking", ts, text }];
    return [];
  }

  // Streaming reasoning delta
  if (type === "assistant.reasoning_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) return [{ kind: "thinking", ts, text: deltaContent, delta: true }];
    return [];
  }

  // Assistant message — may contain text and/or tool requests
  if (type === "assistant.message") {
    const entries: TranscriptEntry[] = [];
    const content = typeof data.content === "string" ? data.content : "";
    if (content) {
      entries.push({ kind: "assistant", ts, text: content });
    }

    // Copilot toolRequests: [{ toolCallId, name, arguments (object), type: "function" }]
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const rawReq of toolRequests) {
      const req = asRecord(rawReq);
      if (!req) continue;

      // name is at the top level of each tool request (not nested under .function)
      const name = typeof req.name === "string" ? req.name : "unknown";
      const toolCallId = typeof req.toolCallId === "string" ? req.toolCallId : undefined;

      // arguments is an object (not a stringified JSON like OpenAI API)
      let input: unknown = {};
      if (typeof req.arguments === "object" && req.arguments !== null) {
        input = req.arguments;
      } else if (typeof req.arguments === "string") {
        try {
          input = JSON.parse(req.arguments);
        } catch {
          input = { raw: req.arguments };
        }
      }

      entries.push({ kind: "tool_call", ts, name, toolUseId: toolCallId, input });
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // Streaming text delta
  if (type === "assistant.message_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) return [{ kind: "assistant", ts, text: deltaContent, delta: true }];
    return [];
  }

  // Tool execution start: { toolCallId, toolName, arguments }
  if (type === "tool.execution_start") {
    const name = typeof data.toolName === "string" ? data.toolName : "unknown";
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
    return [{ kind: "tool_call", ts, name, toolUseId: toolCallId, input: data.arguments ?? {} }];
  }

  // Tool execution complete: { toolCallId, success, result?: { content }, error?: { message, code } }
  if (type === "tool.execution_complete") {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const isError = data.success === false;

    let content = "";
    if (isError) {
      const errObj = asRecord(data.error);
      content = errObj
        ? (typeof errObj.message === "string" ? errObj.message : JSON.stringify(errObj))
        : "Tool execution failed";
    } else {
      const resultObj = asRecord(data.result);
      if (resultObj) {
        content =
          typeof resultObj.content === "string"
            ? resultObj.content
            : JSON.stringify(resultObj);
      }
    }

    return [{ kind: "tool_result", ts, toolUseId: toolCallId, toolName, content, isError }];
  }

  // Final result
  if (type === "result") {
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const exitCode = asNumber(parsed.exitCode);

    return [
      {
        kind: "result",
        ts,
        text: sessionId ? `Session: ${sessionId}` : "",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: exitCode === 0 ? "success" : "error",
        isError: exitCode !== 0,
        errors: exitCode !== 0 ? [`Copilot exited with code ${exitCode}`] : [],
      },
    ];
  }

  // Skip ephemeral events silently (MCP server status, background tasks, etc.)
  if (parsed.ephemeral === true) {
    return [];
  }

  return [{ kind: "stdout", ts, text: line }];
}
