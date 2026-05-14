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

function parseSSEDataLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.startsWith("data: ")) return [{ kind: "stdout", ts, text: line }];
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") return [];

  const parsed = asRecord(safeJsonParse(raw));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = asRecord(choices[0]);
  const delta = asRecord(first?.delta);
  const content = typeof delta?.content === "string" ? delta.content : "";

  if (content.length > 0) {
    return [{ kind: "assistant", ts, text: content, delta: true }];
  }

  const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : null;
  if (finishReason === "stop" || finishReason === "length") return [];

  if (typeof (first?.delta as Record<string, unknown> | null | undefined)?.tool_calls !== "undefined") {
    return [{ kind: "stdout", ts, text: line }];
  }

  return [];
}

export function parseKilocodeGatewayStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("data: ")) {
    return parseSSEDataLine(trimmed, ts);
  }

  return [{ kind: "stdout", ts, text: line }];
}
