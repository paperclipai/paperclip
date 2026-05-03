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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactShellInput(input: unknown): unknown {
  const rec = asRecord(input);
  if (!rec) return input;
  const command = asString(rec.command);
  return command ? { command } : input;
}

function parseAssistantMessage(messageRaw: unknown, ts: string): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }
  const message = asRecord(messageRaw);
  if (!message) return [];
  const directText = asString(message.text).trim();
  if (directText) return [{ kind: "assistant", ts, text: directText }];

  const content = Array.isArray(message.content) ? message.content : [];
  const entries: TranscriptEntry[] = [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const partType = asString(part.type).trim();
    if (partType === "text" || partType === "output_text") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }
    if (partType === "tool_call") {
      const name = asString(part.name, "tool");
      const rawInput = part.input ?? part.arguments ?? part.args ?? {};
      const input = name === "shell" || name === "shellToolCall" ? compactShellInput(rawInput) : rawInput;
      entries.push({
        kind: "tool_call",
        ts,
        name,
        toolUseId: asString(part.tool_use_id) || asString(part.id) || undefined,
        input,
      });
    }
  }
  return entries;
}

function parseToolCallEvent(event: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = asString(event.subtype).trim().toLowerCase();
  const callId = asString(event.call_id) || asString(event.id) || "tool_call";
  const toolCall = asRecord(event.tool_call ?? event.toolCall);
  if (!toolCall) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }
  const [toolName] = Object.keys(toolCall);
  if (!toolName) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }
  const payload = asRecord(toolCall[toolName]) ?? {};
  const isShell = toolName === "shell" || toolName === "shellToolCall";
  const rawInput = payload.args ?? payload;
  const input = isShell ? compactShellInput(rawInput) : rawInput;

  if (subtype === "started" || subtype === "start") {
    return [{ kind: "tool_call", ts, name: toolName, toolUseId: callId, input }];
  }
  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const result = payload.result ?? payload.output ?? payload.error;
    const isError =
      event.is_error === true ||
      payload.is_error === true ||
      asString(payload.status).toLowerCase() === "error" ||
      asString(payload.status).toLowerCase() === "failed";
    const content = result !== undefined ? stringifyUnknown(result) : `${toolName} completed`;
    return [{ kind: "tool_result", ts, toolUseId: callId, content, isError }];
  }
  return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}: ${toolName}` }];
}

export function parseCursorSdkStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) return [{ kind: "stdout", ts, text: trimmed }];

  const type = asString(parsed.type);

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = asString(parsed.sessionId) || asString(parsed.session_id);
      return [{ kind: "init", ts, model: asString(parsed.model, "cursor"), sessionId }];
    }
    return [{ kind: "system", ts, text: subtype ? `system: ${subtype}` : "system" }];
  }

  if (type === "assistant") return parseAssistantMessage(parsed.message, ts);
  if (type === "user") {
    const text = asString(asRecord(parsed.message)?.text).trim() || asString(parsed.text).trim();
    return text ? [{ kind: "user", ts, text }] : [];
  }
  if (type === "thinking") {
    const text = asString(parsed.text).trim();
    if (!text) return [];
    const isDelta = asString(parsed.subtype).toLowerCase() === "delta";
    return [{ kind: "thinking", ts, text, ...(isDelta ? { delta: true } : {}) }];
  }
  if (type === "tool_call") return parseToolCallEvent(parsed, ts);

  if (type === "status") {
    const status = asString(parsed.status) || asString(parsed.runStatus) || "running";
    return [{ kind: "system", ts, text: `status: ${status}` }];
  }
  if (type === "task") {
    const subtype = asString(parsed.subtype);
    const text = asString(parsed.text).trim();
    return [{ kind: "system", ts, text: text ? `task${subtype ? ` (${subtype})` : ""}: ${text}` : `task${subtype ? ` (${subtype})` : ""}` }];
  }
  if (type === "request") {
    const text = asString(parsed.text).trim();
    return [{ kind: "system", ts, text: text ? `request: ${text}` : "request: awaiting input" }];
  }

  if (type === "result") {
    const subtype = asString(parsed.subtype, "result");
    const isError = parsed.is_error === true || subtype === "error" || subtype === "cancelled" || subtype === "failed";
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: asNumber(parsed.costUsd, 0),
      subtype,
      isError,
      errors: [],
    }];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: asString(parsed.message) || trimmed }];
  }

  return [{ kind: "stdout", ts, text: trimmed }];
}
