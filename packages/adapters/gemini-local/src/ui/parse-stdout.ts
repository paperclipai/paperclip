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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function collectTextEntries(messageRaw: unknown, ts: string, kind: "assistant" | "user"): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind, ts, text }] : [];
  }

  const message = asRecord(messageRaw);
  if (!message) return [];

  const entries: TranscriptEntry[] = [];
  const directText = asString(message.text).trim();
  if (directText) entries.push({ kind, ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();
    if (type !== "output_text" && type !== "text" && type !== "content") continue;
    const text = asString(part.text).trim() || asString(part.content).trim();
    if (text) entries.push({ kind, ts, text });
  }

  return entries;
}

function parseAssistantMessage(messageRaw: unknown, ts: string): TranscriptEntry[] {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  const message = asRecord(messageRaw);
  if (!message) return [];

  const entries: TranscriptEntry[] = [];
  const directText = asString(message.text).trim();
  if (directText) entries.push({ kind: "assistant", ts, text: directText });

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();

    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text).trim() || asString(part.content).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
      continue;
    }

    if (type === "tool_call") {
      const name = asString(part.name, asString(part.tool, "tool"));
      entries.push({
        kind: "tool_call",
        ts,
        name,
        input: part.input ?? part.arguments ?? part.args ?? {},
      });
      continue;
    }

    if (type === "tool_result" || type === "tool_response") {
      const toolUseId =
        asString(part.tool_use_id) ||
        asString(part.toolUseId) ||
        asString(part.call_id) ||
        asString(part.id) ||
        "tool_result";
      const contentText =
        asString(part.output) ||
        asString(part.text) ||
        asString(part.result) ||
        stringifyUnknown(part.output ?? part.result ?? part.text ?? part.response);
      const isError = part.is_error === true || asString(part.status).toLowerCase() === "error";
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId,
        content: contentText,
        isError,
      });
    }
  }

  return entries;
}

function parseTopLevelToolEvent(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const subtype = asString(parsed.subtype).trim().toLowerCase();
  const callId = asString(parsed.call_id, asString(parsed.callId, asString(parsed.id, "tool_call")));
  const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
  if (!toolCall) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }

  const [toolName] = Object.keys(toolCall);
  if (!toolName) {
    return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}` }];
  }
  const payload = asRecord(toolCall[toolName]) ?? {};

  if (subtype === "started" || subtype === "start") {
    return [{
      kind: "tool_call",
      ts,
      name: toolName,
      input: payload.args ?? payload.input ?? payload.arguments ?? payload,
    }];
  }

  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const result = payload.result ?? payload.output ?? payload.error;
    const isError =
      parsed.is_error === true ||
      payload.is_error === true ||
      payload.error !== undefined ||
      asString(payload.status).toLowerCase() === "error";
    return [{
      kind: "tool_result",
      ts,
      toolUseId: callId,
      content: result !== undefined ? stringifyUnknown(result) : `${toolName} completed`,
      isError,
    }];
  }

  return [{ kind: "system", ts, text: `tool_call${subtype ? ` (${subtype})` : ""}: ${toolName}` }];
}

function readSessionId(parsed: Record<string, unknown>): string {
  return (
    asString(parsed.session_id) ||
    asString(parsed.sessionId) ||
    asString(parsed.sessionID) ||
    asString(parsed.checkpoint_id) ||
    asString(parsed.thread_id)
  );
}

function readUsage(parsed: Record<string, unknown>) {
  const usage = asRecord(parsed.usage) ?? asRecord(parsed.usageMetadata);
  const usageMetadata = asRecord(usage?.usageMetadata);
  const source = usageMetadata ?? usage ?? {};
  return {
    inputTokens: asNumber(source.input_tokens, asNumber(source.inputTokens, asNumber(source.promptTokenCount))),
    outputTokens: asNumber(source.output_tokens, asNumber(source.outputTokens, asNumber(source.candidatesTokenCount))),
    cachedTokens: asNumber(
      source.cached_input_tokens,
      asNumber(source.cachedInputTokens, asNumber(source.cachedContentTokenCount)),
    ),
  };
}

export function parseGeminiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = readSessionId(parsed);
      return [{ kind: "init", ts, model: asString(parsed.model, "gemini"), sessionId }];
    }
    if (subtype === "error") {
      const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
      return [{ kind: "stderr", ts, text: text || "error" }];
    }
    return [{ kind: "system", ts, text: `system: ${subtype || "event"}` }];
  }

  if (type === "assistant") {
    return parseAssistantMessage(parsed.message, ts);
  }

  if (type === "user") {
    return collectTextEntries(parsed.message, ts, "user");
  }

  if (type === "thinking") {
    const text = asString(parsed.text).trim() || asString(asRecord(parsed.delta)?.text).trim();
    return text ? [{ kind: "thinking", ts, text }] : [];
  }

  if (type === "tool_call") {
    return parseTopLevelToolEvent(parsed, ts);
  }

  if (type === "result") {
    const usage = readUsage(parsed);
    const errors = parsed.is_error === true
      ? [errorText(parsed.error ?? parsed.message ?? parsed.result)].filter(Boolean)
      : [];
    return [{
      kind: "result",
      ts,
      text: asString(parsed.result) || asString(parsed.text) || asString(parsed.response),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost))),
      subtype: asString(parsed.subtype, "result"),
      isError: parsed.is_error === true,
      errors,
    }];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
