import { parseJson } from "@paperclipai/adapter-utils/server-utils";
import type { UsageSummary } from "@paperclipai/adapter-utils";

// qwen-code's `-o stream-json` emits one JSON object per line. The schema is
// not yet pinned in their public docs (verified surface from `qwen --help` in
// 0.15.9), so the parser tolerates unknown event types (logs + skips) and only
// fails on protocol-fatal stream errors. Real fixtures should be captured
// against a live vLLM during Phase 5 to harden this parser.

export type QwenStreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call"; name: string; raw: Record<string, unknown> }
  | { kind: "tool_result"; raw: Record<string, unknown> }
  | { kind: "session"; sessionId: string }
  | { kind: "usage"; usage: UsageSummary }
  | { kind: "result"; raw: Record<string, unknown> }
  | { kind: "error"; message: string; raw: Record<string, unknown> }
  | { kind: "unknown"; type: string | null; raw: Record<string, unknown> };

const TEXT_FIELDS = ["text", "delta", "content"];

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function readUsage(obj: Record<string, unknown>): UsageSummary | null {
  const usageNode =
    (obj.usage as Record<string, unknown> | undefined) ??
    (obj.message && typeof obj.message === "object"
      ? ((obj.message as Record<string, unknown>).usage as Record<string, unknown> | undefined)
      : undefined);
  if (!usageNode) return null;
  const inputTokens = Number(usageNode.input_tokens ?? usageNode.prompt_tokens ?? 0);
  const outputTokens = Number(usageNode.output_tokens ?? usageNode.completion_tokens ?? 0);
  if (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)) return null;
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
  };
}

export function parseQwenStreamLine(line: string): QwenStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const obj = parseJson(trimmed);
  if (!obj) return null;

  const type = typeof obj.type === "string" ? obj.type : null;

  // Error events always win.
  if (type === "error" || obj.error) {
    const message =
      pickString(obj, ["message", "error"]) ??
      (typeof obj.error === "object" && obj.error
        ? pickString(obj.error as Record<string, unknown>, ["message"]) ?? "qwen-code error"
        : "qwen-code error");
    return { kind: "error", message, raw: obj };
  }

  // Session announcement (qwen prints session id at start when --chat-recording).
  const sessionId =
    pickString(obj, ["session_id", "sessionId"]) ??
    (typeof obj.session === "object" && obj.session
      ? pickString(obj.session as Record<string, unknown>, ["id"])
      : null);
  if (sessionId && (type === "session" || type === "session_start" || type === "system")) {
    return { kind: "session", sessionId };
  }

  // Usage rollup (end-of-turn or end-of-stream).
  const usage = readUsage(obj);
  if (usage) {
    return { kind: "usage", usage };
  }

  if (type === "tool_use" || type === "tool_call") {
    const name = pickString(obj, ["name", "tool_name"]) ?? "unknown";
    return { kind: "tool_call", name, raw: obj };
  }
  if (type === "tool_result") {
    return { kind: "tool_result", raw: obj };
  }
  if (type === "result" || type === "final") {
    return { kind: "result", raw: obj };
  }

  // Plain text delta — qwen-code may emit either {type:"content_delta", text} or
  // a bare {delta:"..."} chunk depending on stream mode.
  const text = pickString(obj, TEXT_FIELDS);
  if (text) {
    return { kind: "text_delta", text };
  }

  return { kind: "unknown", type, raw: obj };
}

export function parseQwenStreamBuffer(buffer: string): {
  events: QwenStreamEvent[];
  remainder: string;
} {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const events: QwenStreamEvent[] = [];
  for (const line of lines) {
    const event = parseQwenStreamLine(line);
    if (event) events.push(event);
  }
  return { events, remainder };
}

// Sum usage across all events. qwen-code may emit per-turn rollups in agent
// loops, so we accumulate rather than overwrite.
export function aggregateUsage(events: QwenStreamEvent[]): UsageSummary | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let saw = false;
  for (const event of events) {
    if (event.kind !== "usage") continue;
    inputTokens += event.usage.inputTokens ?? 0;
    outputTokens += event.usage.outputTokens ?? 0;
    saw = true;
  }
  return saw ? { inputTokens, outputTokens } : null;
}

export function collectText(events: QwenStreamEvent[]): string {
  return events
    .filter((event): event is Extract<QwenStreamEvent, { kind: "text_delta" }> => event.kind === "text_delta")
    .map((event) => event.text)
    .join("");
}

export function findSessionId(events: QwenStreamEvent[]): string | null {
  for (const event of events) {
    if (event.kind === "session") return event.sessionId;
  }
  return null;
}

export function findError(events: QwenStreamEvent[]): string | null {
  for (const event of events) {
    if (event.kind === "error") return event.message;
  }
  return null;
}
