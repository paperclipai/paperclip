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

function readAssistantEntries(message: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const entries: TranscriptEntry[] = [];

  for (const blockRaw of content) {
    const block = asRecord(blockRaw);
    if (!block) continue;

    const blockType = asString(block.type);
    if (blockType === "thinking") {
      const text = asString(block.thinking).trim();
      if (text) entries.push({ kind: "thinking", ts, text });
      continue;
    }

    if (blockType === "text") {
      const text = asString(block.text).trim();
      if (text) entries.push({ kind: "assistant", ts, text });
    }
  }

  return entries;
}

export function parsePiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "session") {
    return [{
      kind: "init",
      ts,
      model: "pi",
      sessionId: asString(parsed.id),
    }];
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (!assistantEvent) return [];

    if (asString(assistantEvent.type) === "text_delta") {
      const delta = asString(assistantEvent.delta);
      if (delta) return [{ kind: "assistant", ts, text: delta }];
    }
    return [];
  }

  if (type === "message_end") {
    const message = asRecord(parsed.message);
    if (!message) return [{ kind: "stdout", ts, text: line }];
    if (asString(message.role) !== "assistant") return [];

    const entries = readAssistantEntries(message, ts);
    return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message) ?? {};
    const usage = asRecord(message.usage) ?? {};
    const cost = asRecord(usage.cost) ?? {};
    const summary = readAssistantEntries(message, ts)
      .filter((entry) => entry.kind === "assistant")
      .map((entry) => entry.text)
      .join("\n\n")
      .trim();

    return [{
      kind: "result",
      ts,
      text: summary,
      inputTokens: asNumber(usage.input),
      outputTokens: asNumber(usage.output),
      cachedTokens: asNumber(usage.cacheRead),
      costUsd: asNumber(cost.total),
      subtype: asString(message.stopReason),
      isError: false,
      errors: [],
    }];
  }

  if (type === "error") {
    const message = asString(parsed.message).trim();
    return [{ kind: "stderr", ts, text: message || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
