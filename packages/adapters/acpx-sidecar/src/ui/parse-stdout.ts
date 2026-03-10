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

export function parseAcpxSidecarStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = safeJsonParse(line.trim());
  const event = asRecord(parsed);
  if (!event) return line.trim() ? [{ kind: "stdout", ts, text: line.trim() }] : [];

  const method = asString(event.method);
  if (method === "session/update") {
    const params = asRecord(event.params);
    const updateType = asString(params?.sessionUpdate);
    const content = asRecord(params?.content);
    if (updateType === "agent_message_chunk" && asString(content?.type) === "text") {
      const text = asString(content?.text).trim();
      return text ? [{ kind: "assistant", ts, text, delta: true }] : [];
    }
    if (updateType === "agent_thought_chunk" && asString(content?.type) === "text") {
      const text = asString(content?.text).trim();
      return text ? [{ kind: "thinking", ts, text, delta: true }] : [];
    }
    return [];
  }

  const result = asRecord(event.result);
  if (result) {
    const stopReason = asString(result.stopReason).trim();
    return stopReason
      ? [{
          kind: "result",
          ts,
          text: stopReason,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costUsd: 0,
          subtype: stopReason,
          isError: false,
          errors: [],
        }]
      : [];
  }

  const error = asRecord(event.error);
  if (error) {
    const text = asString(error.message).trim();
    return text ? [{ kind: "stderr", ts, text }] : [];
  }

  return [];
}
