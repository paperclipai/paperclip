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

function parseWireEvent(line: string): { type: string; payload: Record<string, unknown> } | null {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return null;
  if (asString(parsed.jsonrpc) !== "2.0") return null;
  if (asString(parsed.method) !== "event") return null;
  const params = asRecord(parsed.params);
  if (!params) return null;
  const eventType = asString(params.type);
  if (!eventType) return null;
  return { type: eventType, payload: asRecord(params.payload) ?? {} };
}

function parseToolCall(payload: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const func = asRecord(payload.function);
  const name = asString(func?.name, asString(payload.name, "tool"));
  let input: Record<string, unknown> = {};
  try {
    const args = asString(func?.arguments, asString(payload.arguments));
    if (args) input = JSON.parse(args);
  } catch {
    input = { raw: func?.arguments ?? payload.arguments };
  }
  return [{
    kind: "tool_call",
    ts,
    name,
    toolUseId: asString(payload.id),
    input,
  }];
}

function parseToolResult(payload: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const returnValue = asRecord(payload.return_value);
  const isError = returnValue?.is_error === true;
  const output = asString(returnValue?.output, asString(returnValue?.message, ""));
  return [{
    kind: "tool_result",
    ts,
    toolUseId: asString(payload.tool_call_id, "tool_result"),
    content: output,
    isError,
  }];
}

export function parseKimiStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const event = parseWireEvent(line);
  if (!event) {
    const text = line.trim();
    return text ? [{ kind: "stdout", ts, text }] : [];
  }

  switch (event.type) {
    case "TurnBegin":
      return [{ kind: "system", ts, text: "turn started" }];
    case "StepBegin": {
      const n = asNumber(event.payload.n);
      return [{ kind: "system", ts, text: `step ${n} started` }];
    }
    case "ContentPart": {
      const partType = asString(event.payload.type);
      if (partType === "think") {
        const think = asString(event.payload.think);
        return think ? [{ kind: "thinking", ts, text: think }] : [];
      }
      if (partType === "text") {
        const text = asString(event.payload.text);
        return text ? [{ kind: "assistant", ts, text }] : [];
      }
      return [];
    }
    case "ToolCall":
      return parseToolCall(event.payload, ts);
    case "ToolResult":
      return parseToolResult(event.payload, ts);
    case "TurnEnd":
      return [{ kind: "system", ts, text: "turn ended" }];
    case "StatusUpdate": {
      const tokenUsage = asRecord(event.payload.token_usage);
      if (!tokenUsage) return [];
      return [{
        kind: "result",
        ts,
        text: "turn completed",
        inputTokens: asNumber(tokenUsage.input_other),
        outputTokens: asNumber(tokenUsage.output),
        cachedTokens: asNumber(tokenUsage.input_cache_read),
        costUsd: 0,
        subtype: "turn_end",
        isError: false,
        errors: [],
      }];
    }
    default:
      return [];
  }
}
