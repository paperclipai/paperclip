import type { TranscriptEntry, StatefulStdoutParser } from "../types";

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

function flushAccumulated(
  kind: "think" | "text" | null,
  buffer: string,
  ts: string,
): TranscriptEntry[] {
  if (!kind || !buffer) return [];
  if (kind === "think") {
    return [{ kind: "thinking", ts, text: buffer }];
  }
  return [{ kind: "assistant", ts, text: buffer }];
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

function parseStatusUpdate(payload: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const tokenUsage = asRecord(payload.token_usage);
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

export function createKimiStdoutParser(): StatefulStdoutParser {
  let lastKind: "think" | "text" | null = null;
  let buffer = "";
  let lastTs = "";

  function flush(ts: string): TranscriptEntry[] {
    const entries = flushAccumulated(lastKind, buffer, lastTs || ts);
    lastKind = null;
    buffer = "";
    lastTs = "";
    return entries;
  }

  return {
    parseLine(line: string, ts: string): TranscriptEntry[] {
      const event = parseWireEvent(line);
      if (!event) {
        const text = line.trim();
        if (!text) return [];
        const flushed = flush(ts);
        return [...flushed, { kind: "stdout", ts, text }];
      }

      switch (event.type) {
        case "ContentPart": {
          const partType = asString(event.payload.type);
          if (partType === "think" || partType === "text") {
            const text = partType === "think"
              ? asString(event.payload.think)
              : asString(event.payload.text);
            if (!text) return [];
            if (lastKind !== partType) {
              const flushed = flush(ts);
              lastKind = partType;
              buffer = text;
              lastTs = ts;
              return flushed;
            }
            buffer += text;
            return [];
          }
          return [];
        }
        case "ToolCall": {
          const flushed = flush(ts);
          return [...flushed, ...parseToolCall(event.payload, ts)];
        }
        case "ToolResult": {
          const flushed = flush(ts);
          return [...flushed, ...parseToolResult(event.payload, ts)];
        }
        case "TurnBegin": {
          const flushed = flush(ts);
          return [...flushed, { kind: "system", ts, text: "turn started" }];
        }
        case "StepBegin": {
          const flushed = flush(ts);
          const n = asNumber(event.payload.n);
          return [...flushed, { kind: "system", ts, text: `step ${n} started` }];
        }
        case "TurnEnd": {
          const flushed = flush(ts);
          return [...flushed, { kind: "system", ts, text: "turn ended" }];
        }
        case "StatusUpdate": {
          const flushed = flush(ts);
          return [...flushed, ...parseStatusUpdate(event.payload, ts)];
        }
        default:
          return [];
      }
    },
    reset(): void {
      lastKind = null;
      buffer = "";
      lastTs = "";
    },
  };
}
