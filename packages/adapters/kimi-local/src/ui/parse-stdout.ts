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

function parseLineInternal(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const role = asString(parsed.role).trim();

  if (role === "assistant") {
    const content = asString(parsed.content);
    if (!content) return [];
    const toolCalls = parsed.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const entries: TranscriptEntry[] = [];
      if (content) {
        entries.push({ kind: "assistant", ts, text: content, delta: true });
      }
      for (const tc of toolCalls) {
        const tcRecord = asRecord(tc);
        if (!tcRecord) continue;
        const type = asString(tcRecord.type);
        if (type === "function") {
          const fn = asRecord(tcRecord.function);
          const name = asString(fn?.name);
          const input = asString(fn?.arguments) || asString(fn?.arguments);
          if (name) {
            entries.push({ kind: "tool_call", ts, name, input: input || undefined });
          }
        }
      }
      return entries;
    }
    return [{ kind: "assistant", ts, text: content, delta: true }];
  }

  if (role === "tool") {
    const content = asString(parsed.content);
    const toolCallId = asString(parsed.tool_call_id);
    if (!content && !toolCallId) return [];
    return [{
      kind: "tool_result",
      ts,
      toolUseId: toolCallId || "",
      content: content || "",
      isError: false,
    }];
  }

  if (role === "error") {
    const text = asString(parsed.content) || asString(parsed.message) || "Kimi error";
    return [{ kind: "stderr", ts, text }];
  }

  return [{ kind: "stdout", ts, text: line }];
}

export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parseLineInternal(line, ts);
}
