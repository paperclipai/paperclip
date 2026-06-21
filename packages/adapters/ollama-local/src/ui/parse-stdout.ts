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

    if (type === "text" || type === "content") {
      const text = asString(part.text).trim() || asString(part.content).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.thinking).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
      continue;
    }

    if (type === "tool_use") {
      const name = asString(part.name, "tool");
      entries.push({
        kind: "tool_call",
        ts,
        name,
        input: part.input ?? part.arguments ?? part.args ?? {},
      });
      continue;
    }

    if (type === "tool_result") {
      const toolUseId = asString(part.tool_use_id) || asString(part.toolUseId) || "tool_result";
      const contentText =
        asString(part.content) ||
        asString(part.text) ||
        stringifyUnknown(part.content ?? part.text);
      const isError = part.is_error === true;
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

function readSessionId(parsed: Record<string, unknown>): string {
  return (
    asString(parsed.session_id) ||
    asString(parsed.sessionId) ||
    asString(parsed.sessionID)
  );
}

function readUsage(parsed: Record<string, unknown>) {
  const usage = asRecord(parsed.usage);
  if (!usage) return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  return {
    inputTokens: asNumber(usage.input_tokens, asNumber(usage.inputTokens)),
    outputTokens: asNumber(usage.output_tokens, asNumber(usage.outputTokens)),
    cachedTokens: asNumber(usage.cached_input_tokens, asNumber(usage.cachedInputTokens)),
  };
}

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = readSessionId(parsed);
      return [{ kind: "init", ts, model: asString(parsed.model, "ollama"), sessionId }];
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
    const message = asRecord(parsed.message);
    if (!message) return [];
    const entries: TranscriptEntry[] = [];
    const directText = asString(message.text).trim();
    if (directText) entries.push({ kind: "user", ts, text: directText });

    const content = Array.isArray(message.content) ? message.content : [];
    for (const partRaw of content) {
      const part = asRecord(partRaw);
      if (!part) continue;
      if (asString(part.type) === "tool_result") {
        const toolUseId = asString(part.tool_use_id) || asString(part.toolUseId) || "tool_result";
        const contentText =
          asString(part.content) ||
          asString(part.text) ||
          stringifyUnknown(part.content ?? part.text);
        const isError = part.is_error === true;
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

  if (type === "result") {
    const usage = readUsage(parsed);
    const isError = parsed.is_error === true;
    const resultText = asString(parsed.result);
    const entries: TranscriptEntry[] = [];
    
    if (resultText) {
      entries.push({ kind: "assistant", ts, text: resultText });
    }
    
    entries.push({
      kind: "result",
      ts,
      text: resultText || "",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      costUsd: 0,
      subtype: "complete",
      isError,
      errors: [],
    });
    
    return entries;
  }

  return [{ kind: "stdout", ts, text: line }];
}
