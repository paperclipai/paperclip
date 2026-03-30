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

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = typeof parsed.type === "string" ? parsed.type : "";
  const data = asRecord(parsed.data) ?? {};

  // session.tools_updated — treat as init
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

  // assistant.message — text content and/or tool requests
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
      const toolName = typeof req.name === "string" ? req.name : typeof req.toolName === "string" ? req.toolName : "unknown";
      const toolCallId = typeof req.toolCallId === "string" ? req.toolCallId : undefined;
      entries.push({
        kind: "tool_call",
        ts,
        name: toolName,
        toolUseId: toolCallId,
        input: req.arguments ?? {},
      });
    }
    if (entries.length > 0) return entries;
    return [{ kind: "stdout", ts, text: line }];
  }

  // tool.execution_complete — tool result
  if (type === "tool.execution_complete") {
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const toolName = typeof data.toolName === "string" ? data.toolName : undefined;
    const success = data.success !== false;
    const result = asRecord(data.result);
    const resultContent = result && typeof result.content === "string" ? result.content : "";
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: toolCallId,
        toolName,
        content: resultContent,
        isError: !success,
      },
    ];
  }

  // result — session summary with usage stats
  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premiumRequests = asNumber(usage.premiumRequests);
    const sessionDurationMs = asNumber(usage.sessionDurationMs);
    const exitCode = asNumber(parsed.exitCode);
    const codeChanges = asRecord(usage.codeChanges);
    const linesAdded = codeChanges ? asNumber(codeChanges.linesAdded) : 0;
    const linesRemoved = codeChanges ? asNumber(codeChanges.linesRemoved) : 0;

    const parts: string[] = [];
    parts.push(`Exit code: ${exitCode}`);
    parts.push(`Premium requests: ${premiumRequests}`);
    if (sessionDurationMs > 0) parts.push(`Duration: ${(sessionDurationMs / 1000).toFixed(1)}s`);
    if (linesAdded > 0 || linesRemoved > 0) parts.push(`Changes: +${linesAdded}/-${linesRemoved}`);

    return [
      {
        kind: "result",
        ts,
        text: parts.join(", "),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "",
        isError: exitCode !== 0,
        errors: [],
      },
    ];
  }

  // Skip ephemeral events (message_delta, mcp_servers_loaded, etc.)
  const ephemeral = parsed.ephemeral === true;
  if (ephemeral) return [];

  // user.message
  if (type === "user.message") {
    const content = typeof data.content === "string" ? data.content : "";
    if (content) return [{ kind: "user", ts, text: content }];
  }

  // assistant.turn_start / assistant.turn_end — skip silently
  if (type === "assistant.turn_start" || type === "assistant.turn_end") {
    return [];
  }

  // tool.execution_start — skip (we report on completion)
  if (type === "tool.execution_start") {
    return [];
  }

  return [{ kind: "stdout", ts, text: line }];
}
