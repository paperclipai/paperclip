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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseAssistantMessage(message: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const entries: TranscriptEntry[] = [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();
    if (type === "text") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }
    if (type === "tool_use") {
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(part.name, "tool"),
        toolUseId: asString(part.id) || undefined,
        input: part.input ?? {},
      });
    }
  }
  return entries;
}

function parseSdkMessage(messageRaw: unknown, ts: string): TranscriptEntry[] {
  const message = asRecord(messageRaw);
  if (!message) return [];
  const type = asString(message.type);

  if (type === "assistant") {
    const body = asRecord(message.message);
    return body ? parseAssistantMessage(body, ts) : [];
  }

  if (type === "user") {
    const body = asRecord(message.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    const text = content
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => asString(entry.text).trim())
      .filter(Boolean)
      .join("\n");
    return text ? [{ kind: "user", ts, text }] : [];
  }

  if (type === "thinking") {
    const text = asString(message.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool_call") {
    const toolUseId = asString(message.call_id, asString(message.id, "tool_call"));
    const status = asString(message.status).toLowerCase();
    if (status === "running") {
      return [{
        kind: "tool_call",
        ts,
        name: asString(message.name, "tool"),
        toolUseId,
        input: message.args ?? {},
      }];
    }
    if (status === "completed" || status === "error") {
      return [{
        kind: "tool_result",
        ts,
        toolUseId,
        toolName: asString(message.name, "tool"),
        content: stringifyUnknown(message.result ?? message.args ?? {}),
        isError: status === "error",
      }];
    }
    return [];
  }

  if (type === "tool_result") {
    const toolUseId = asString(message.call_id, asString(message.id, "tool_result"));
    const isError =
      message.is_error === true ||
      asString(message.status).toLowerCase() === "error";
    return [{
      kind: "tool_result",
      ts,
      toolUseId,
      toolName: asString(message.name, "tool"),
      content: stringifyUnknown(message.result ?? message.content ?? message.output ?? {}),
      isError,
    }];
  }

  if (type === "status") {
    const status = asString(message.status);
    const statusMessage = asString(message.message);
    return [{
      kind: "system",
      ts,
      text: `status: ${status}${statusMessage ? ` - ${statusMessage}` : ""}`,
    }];
  }

  if (type === "task") {
    const text = asString(message.text).trim();
    return text ? [{ kind: "system", ts, text }] : [];
  }

  return [];
}

export function parseCursorCloudStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);
  if (type === "cursor_cloud.init") {
    const sessionId = asString(parsed.sessionId, asString(parsed.agentId));
    return [{
      kind: "init",
      ts,
      model: asString(parsed.model, "cursor_cloud"),
      sessionId,
    }];
  }

  if (type === "cursor_cloud.status") {
    return [{
      kind: "system",
      ts,
      text: `${asString(parsed.status, "status")}${parsed.message ? `: ${asString(parsed.message)}` : ""}`,
    }];
  }

  if (type === "cursor_cloud.message") {
    return parseSdkMessage(parsed.message, ts);
  }

  if (type === "cursor_cloud.result") {
    const status = asString(parsed.status, "error");
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: status,
      isError: status !== "finished",
      errors: parsed.error ? [asString(parsed.error)] : [],
    }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
