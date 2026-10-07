import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function parseOpenAiCompatibleStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];
  switch (asString(parsed.type)) {
    case "openai_compatible.init":
      return [{
        kind: "init",
        ts,
        model: asString(parsed.model, "openai_compatible"),
        sessionId: asString(parsed.sessionId),
      }];
    case "openai_compatible.assistant": {
      const text = asString(parsed.text).trim();
      return text ? [{ kind: "assistant", ts, text }] : [];
    }
    case "openai_compatible.thinking": {
      const text = asString(parsed.text).trim();
      return text ? [{ kind: "thinking", ts, text }] : [];
    }
    case "openai_compatible.tool_call":
      return [{
        kind: "tool_call",
        ts,
        name: asString(parsed.name, "tool"),
        toolUseId: asString(parsed.id) || undefined,
        input: parsed.input ?? {},
      }];
    case "openai_compatible.tool_result":
      return [{
        kind: "tool_result",
        ts,
        toolUseId: asString(parsed.id, "tool_result"),
        toolName: asString(parsed.name, "tool"),
        content: asString(parsed.content),
        isError: parsed.isError === true,
      }];
    case "openai_compatible.result": {
      const usage = asRecord(parsed.usage);
      const status = asString(parsed.status, "error");
      const error = asString(parsed.error);
      return [{
        kind: "result",
        ts,
        text: asString(parsed.text),
        inputTokens: asCount(usage?.inputTokens),
        outputTokens: asCount(usage?.outputTokens),
        cachedTokens: asCount(usage?.cachedInputTokens),
        costUsd: 0,
        subtype: status,
        isError: status !== "completed",
        errors: error ? [error] : [],
      }];
    }
    default:
      return [{ kind: "stdout", ts, text: line }];
  }
}
