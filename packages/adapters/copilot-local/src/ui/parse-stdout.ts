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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  const rec = asRecord(result);
  if (rec) {
    const content = asString(rec.content).trim();
    if (content) return content;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  const data = asRecord(parsed.data) ?? {};

  if (asBoolean(parsed.ephemeral) && type === "assistant.message_delta") {
    return [];
  }

  if (type === "assistant.message_delta") {
    return [];
  }

  if (type === "session.tools_updated") {
    const model = asString(data.model);
    const sessionId = asString(parsed.id);
    return [
      {
        kind: "init",
        ts,
        model,
        sessionId,
      },
    ];
  }

  if (type === "session.mcp_servers_loaded" || type === "session.skills_loaded" || type === "session.mcp_server_status_changed" || type === "session.background_tasks_changed") {
    if (asBoolean(parsed.ephemeral)) return [];
    const text =
      type === "session.mcp_servers_loaded"
        ? `mcp servers loaded`
        : type === "session.skills_loaded"
          ? `skills loaded`
          : type === "session.mcp_server_status_changed"
            ? `mcp server: ${asString(data.serverName)} ${asString(data.status)}`
            : `background tasks updated`;
    return [{ kind: "system", ts, text }];
  }

  if (type === "user.message") {
    const content = asString(data.content).trim();
    if (!content) return [];
    return [{ kind: "user", ts, text: content }];
  }

  if (type === "assistant.turn_start") {
    return [{ kind: "system", ts, text: "turn started" }];
  }

  if (type === "assistant.turn_end") {
    return [];
  }

  if (type === "assistant.reasoning") {
    const text = asString(data.text).trim();
    if (!text) return [];
    return [{ kind: "thinking", ts, text }];
  }

  if (type === "assistant.message") {
    const out: TranscriptEntry[] = [];
    const content = asString(data.content).trim();
    if (content) {
      out.push({ kind: "assistant", ts, text: content });
    }
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const tr of toolRequests) {
      const trRec = asRecord(tr);
      if (!trRec) continue;
      out.push({
        kind: "tool_call",
        ts,
        name: asString(trRec.name, "tool"),
        input: trRec.arguments ?? {},
        toolUseId: asString(trRec.toolCallId) || asString(trRec.callId) || undefined,
      });
    }
    return out;
  }

  if (type === "tool.execution_start") {
    const toolName = asString(data.toolName, "tool");
    const callId = asString(data.toolCallId) || asString(data.callId);
    return [{ kind: "system", ts, text: `tool start: ${toolName}${callId ? ` (${callId})` : ""}` }];
  }

  if (type === "tool.execution_complete") {
    const callId = asString(data.toolCallId) || asString(data.callId) || "";
    const errorRec = asRecord(data.error);
    const success = data.success;
    const isError =
      success === false ||
      (errorRec !== null && Object.keys(errorRec).length > 0) ||
      (typeof data.error === "string" && (data.error as string).trim().length > 0);
    let content = stringifyToolResult(data.result);
    if (!content && isError) {
      content = stringifyToolResult(data.error);
    }
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: callId,
        toolName: asString(data.toolName) || undefined,
        content: content || (isError ? "tool failed" : "tool completed"),
        isError,
      },
    ];
  }

  if (type === "tool.execution_partial_result") {
    return [];
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premium = asNumber(usage.premiumRequests, 0);
    const sessionMs = asNumber(usage.sessionDurationMs, 0);
    const apiMs = asNumber(usage.totalApiDurationMs, 0);
    const sessionId = asString(parsed.sessionId);
    const exitCode = asNumber(parsed.exitCode, 0);
    const text = `Copilot finished — premium=${premium}, apiMs=${apiMs}, sessionMs=${sessionMs}${sessionId ? `, session=${sessionId}` : ""}`;
    return [
      {
        kind: "result",
        ts,
        text,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "result",
        isError: exitCode !== 0,
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const message = asString((asRecord(parsed.error) ?? {}).message) || asString(parsed.message) || line;
    return [{ kind: "stderr", ts, text: message }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
