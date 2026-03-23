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
 * Parse a single JSONL line from Copilot CLI stdout into TranscriptEntry[].
 *
 * Copilot CLI JSONL uses:
 *   type: "session.tools_updated" → model init
 *   type: "assistant.message"     → text content, tool requests
 *   type: "assistant.message_delta" → streaming text delta
 *   type: "user.message"          → user prompt
 *   type: "tool.execution_start"  → tool invocation
 *   type: "tool.execution_complete" → tool result
 *   type: "result"                → terminal event with session/usage
 */
export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data) ?? {};

  // Model init event
  if (type === "session.tools_updated") {
    const model = typeof data.model === "string" ? data.model : "unknown";
    return [
      {
        kind: "init",
        ts,
        model,
        sessionId: "",
      },
    ];
  }

  // Streaming text delta
  if (type === "assistant.message_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) {
      return [{ kind: "assistant", ts, text: deltaContent, delta: true }];
    }
    return [];
  }

  // Full assistant message (with possible tool requests)
  if (type === "assistant.message") {
    const entries: TranscriptEntry[] = [];
    const content = typeof data.content === "string" ? data.content : "";
    if (content) {
      entries.push({ kind: "assistant", ts, text: content });
    }
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const reqRaw of toolRequests) {
      const req = asRecord(reqRaw);
      if (!req) continue;
      entries.push({
        kind: "tool_call",
        ts,
        name: typeof req.name === "string" ? req.name : "unknown",
        toolUseId: typeof req.toolCallId === "string" ? req.toolCallId : undefined,
        input: req.arguments ?? {},
      });
    }
    // Extended thinking
    const reasoningText = typeof data.reasoningText === "string" ? data.reasoningText : "";
    if (reasoningText) {
      entries.push({ kind: "thinking", ts, text: reasoningText });
    }
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  // Reasoning delta (extended thinking stream)
  if (type === "assistant.reasoning_delta") {
    const deltaContent = typeof data.deltaContent === "string" ? data.deltaContent : "";
    if (deltaContent) {
      return [{ kind: "thinking", ts, text: deltaContent, delta: true }];
    }
    return [];
  }

  // User message
  if (type === "user.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) {
      return [{ kind: "user", ts, text: content }];
    }
    return [{ kind: "stdout", ts, text: line }];
  }

  // Tool execution start
  if (type === "tool.execution_start") {
    return [
      {
        kind: "tool_call",
        ts,
        name: typeof data.toolName === "string" ? data.toolName : "unknown",
        toolUseId: typeof data.toolCallId === "string" ? data.toolCallId : undefined,
        input: data.arguments ?? {},
      },
    ];
  }

  // Tool execution complete
  if (type === "tool.execution_complete") {
    const result = asRecord(data.result) ?? {};
    const content = typeof result.content === "string" ? result.content : "";
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: typeof data.toolCallId === "string" ? data.toolCallId : "",
        content,
        isError: data.success === false,
      },
    ];
  }

  // Terminal result event
  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const outputTokens = 0; // Not available in result event
    const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const exitCode = asNumber(parsed.exitCode);
    const isError = exitCode !== 0;
    return [
      {
        kind: "result",
        ts,
        text: sessionId ? `Session: ${sessionId}` : "",
        inputTokens: 0,
        outputTokens,
        cachedTokens: 0,
        costUsd: 0,
        subtype: isError ? "error" : "",
        isError,
        errors: isError ? [`Exit code: ${exitCode}`] : [],
      },
    ];
  }

  // Ephemeral events we can skip (session.mcp_servers_loaded, session.background_tasks_changed)
  if (type.startsWith("session.") || type === "assistant.turn_start" || type === "assistant.turn_end" || type === "assistant.reasoning") {
    return [];
  }

  return [{ kind: "stdout", ts, text: line }];
}
