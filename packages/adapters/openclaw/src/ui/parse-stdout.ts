import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { normalizeOpenClawStreamLine } from "../shared/stream.js";

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
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function readErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const obj = asRecord(value);
  if (!obj) return stringifyUnknown(value);
  return (
    asString(obj.message).trim() ||
    asString(obj.error).trim() ||
    asString(obj.code).trim() ||
    stringifyUnknown(obj)
  );
}

function readDeltaText(payload: Record<string, unknown> | null): string {
  if (!payload) return "";

  if (typeof payload.delta === "string") return payload.delta;

  const deltaObj = asRecord(payload.delta);
  if (deltaObj) {
    const nestedDelta =
      asString(deltaObj.text) ||
      asString(deltaObj.value) ||
      asString(deltaObj.delta);
    if (nestedDelta.length > 0) return nestedDelta;
  }

  const part = asRecord(payload.part);
  if (part) {
    const partText = asString(part.text);
    if (partText.length > 0) return partText;
  }

  return "";
}

function extractResponseOutputText(response: Record<string, unknown> | null): string {
  if (!response) return "";

  const output = Array.isArray(response.output) ? response.output : [];
  const parts: string[] = [];
  for (const itemRaw of output) {
    const item = asRecord(itemRaw);
    if (!item) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const partRaw of content) {
      const part = asRecord(partRaw);
      if (!part) continue;
      const type = asString(part.type).trim().toLowerCase();
      if (type !== "output_text" && type !== "text" && type !== "refusal") continue;
      const text = asString(part.text).trim();
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n").trim();
}

function parseOpenClawSseLine(line: string, ts: string): TranscriptEntry[] {
  const match = line.match(/^\[openclaw:sse\]\s+event=([^\s]+)\s+data=(.*)$/s);
  if (!match) return [{ kind: "stdout", ts, text: line }];

  const eventType = (match[1] ?? "").trim();
  const dataText = (match[2] ?? "").trim();
  const parsed = asRecord(safeJsonParse(dataText));
  const normalizedEventType = eventType.toLowerCase();

  if (dataText === "[DONE]") {
    return [];
  }

  const delta = readDeltaText(parsed);
  if (normalizedEventType.endsWith(".delta") && delta.length > 0) {
    return [{ kind: "assistant", ts, text: delta, delta: true }];
  }

  if (
    normalizedEventType.includes("error") ||
    normalizedEventType.includes("failed") ||
    normalizedEventType.includes("cancel")
  ) {
    const message = readErrorText(parsed?.error) || readErrorText(parsed?.message) || dataText;
    return message ? [{ kind: "stderr", ts, text: message }] : [];
  }

  if (normalizedEventType === "response.completed" || normalizedEventType.endsWith(".completed")) {
    const response = asRecord(parsed?.response);
    const usage = asRecord(response?.usage);
    const status = asString(response?.status, asString(parsed?.status, eventType));
    const statusLower = status.trim().toLowerCase();
    const errorText =
      readErrorText(response?.error).trim() ||
      readErrorText(parsed?.error).trim() ||
      readErrorText(parsed?.message).trim();
    const isError =
      statusLower === "failed" ||
      statusLower === "error" ||
      statusLower === "cancelled";

    return [{
      kind: "result",
      ts,
      text: extractResponseOutputText(response),
      inputTokens: asNumber(usage?.input_tokens),
      outputTokens: asNumber(usage?.output_tokens),
      cachedTokens: asNumber(usage?.cached_input_tokens),
      costUsd: asNumber(usage?.cost_usd, asNumber(usage?.total_cost_usd)),
      subtype: status || eventType,
      isError,
      errors: errorText ? [errorText] : [],
    }];
  }

  return [];
}

export function parseOpenClawStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const normalized = normalizeOpenClawStreamLine(line);
  if (normalized.stream === "stderr") {
    return [{ kind: "stderr", ts, text: normalized.line }];
  }

  const trimmed = normalized.line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[openclaw:sse]")) {
    return parseOpenClawSseLine(trimmed, ts);
  }

  if (trimmed.startsWith("[openclaw]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[openclaw\]\s*/, "") }];
  }

  return [{ kind: "stdout", ts, text: normalized.line }];
}
