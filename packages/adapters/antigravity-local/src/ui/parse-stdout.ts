// Browser-side stdout stream parser for Antigravity transcript rendering in Paperclip

import type { TranscriptEntry } from "@paperclipai/adapter-utils";

// Safely attempts JSON parse, returning null on error
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Asserts value is a record object
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Safely coerces value to string with fallback
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// Safely coerces value to finite number with fallback
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Serializes unknown value to formatted string
function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Extracts error message string from unknown payload
function errorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg.trim();
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// Extracts session ID from an Antigravity event payload
function readSessionId(parsed: Record<string, unknown>): string {
  return (
    asString(parsed.conversation_id) ||
    asString(parsed.conversationId) ||
    asString(parsed.session_id) ||
    asString(parsed.sessionId)
  );
}

// Parses an Antigravity stdout line into transcript entries for UI display
export function parseAntigravityStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventName = asString(parsed.event, asString(parsed.type)).trim().toLowerCase();

  // Handle initialization event
  if (eventName === "init") {
    const sessionId = readSessionId(parsed);
    const model = asString(parsed.model, "antigravity");
    return [{ kind: "init", ts, model, sessionId: sessionId || "" }];
  }

  // Handle turn step updates
  if (eventName === "step_update") {
    const step = asRecord(parsed.step_update) ?? asRecord(parsed.step) ?? parsed;
    const stepType = asString(step.step_type ?? step.type).trim().toLowerCase();

    if (stepType === "agent_response" || stepType === "planner_response") {
      const text = asString(step.text_delta ?? step.content ?? step.text);
      if (text) return [{ kind: "assistant", ts, text }];
      return [];
    }

    if (stepType === "thinking") {
      const text = asString(step.thinking ?? step.text ?? step.content);
      if (text) return [{ kind: "thinking", ts, text }];
      return [];
    }

    if (stepType === "tool_call") {
      const name = asString(step.tool_name ?? step.name, "tool");
      return [{
        kind: "tool_call",
        ts,
        name,
        input: step.input ?? step.arguments ?? step.args ?? {},
      }];
    }

    if (stepType === "tool_result") {
      const isError = step.is_error === true || asString(step.status).toLowerCase() === "error";
      const content = asString(step.output ?? step.result, stringifyUnknown(step.output ?? step.result));
      return [{
        kind: "tool_result",
        ts,
        toolUseId: asString(step.call_id ?? step.id, "tool_result"),
        content,
        isError,
      }];
    }

    return [];
  }

  // Handle final result event
  if (eventName === "result") {
    const res = asRecord(parsed.result) ?? parsed;
    const status = asString(res.status).toLowerCase();
    const isError = status === "error" || status === "failure" || res.is_error === true;
    const err = isError ? [errorText(res.error ?? res.message ?? res.response)].filter(Boolean) : [];
    const usage = asRecord(res.usage) ?? {};

    return [{
      kind: "result",
      ts,
      text: asString(res.response),
      inputTokens: asNumber(usage.input_tokens, asNumber(usage.inputTokens)),
      outputTokens: asNumber(usage.output_tokens, asNumber(usage.outputTokens)),
      cachedTokens: asNumber(usage.cache_read_tokens, asNumber(usage.cachedTokens)),
      costUsd: asNumber(res.cost_usd, asNumber(res.total_cost_usd)),
      subtype: status || "result",
      isError,
      errors: err,
    }];
  }

  // Handle error event
  if (eventName === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    return [{ kind: "stderr", ts, text: text || "error" }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
