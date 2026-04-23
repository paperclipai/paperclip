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

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const msg =
    asString(rec.message) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function parseToolUse(parsed: Record<string, unknown>, ts: string): TranscriptEntry[] {
  const part = asRecord(parsed.part);
  if (!part) return [{ kind: "system", ts, text: "tool event" }];

  const toolName = asString(part.tool, "tool");
  const state = asRecord(part.state) || asRecord(part.status);
  const input = state?.input ?? part?.input ?? {};
  const callEntry: TranscriptEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    toolUseId: asString(part.callID) || asString(part.id) || undefined,
    input,
  };

  const status = asString(state?.status) || asString(part.status);
  if (status !== "completed" && status !== "error" && status !== "failed") return [callEntry];

  const rawOutput =
    asString(state?.output) ||
    asString(state?.error) ||
    asString(part.output) ||
    asString(part.error) ||
    asString(part.title) ||
    `${toolName} ${status}`;

  const metadata = asRecord(state?.metadata) || asRecord(part.metadata);
  const headerParts: string[] = [`status: ${status}`];
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null) headerParts.push(`${key}: ${value}`);
    }
  }
  const content = `${headerParts.join("\n")}\n\n${rawOutput}`.trim();

  return [
    callEntry,
    {
      kind: "tool_result",
      ts,
      toolUseId: asString(part.callID) || asString(part.id, toolName),
      content,
      isError: status === "error" || status === "failed",
    },
  ];
}

export function parseOpenHandsStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type) || asString(parsed.event_type);

  // Parse message/thinking text
  if (type === "message" || type === "thinking" || type === "text") {
    const text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    const trimmed = text.trim();
    if (!trimmed) return [];
    const kind = type === "thinking" ? "thinking" : "assistant";
    return [{ kind, ts, text: trimmed }];
  }

  // Parse reasoning
  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text) || asString(parsed.text);
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ kind: "thinking", ts, text: trimmed }];
  }

  // Parse tool use
  if (type === "tool_use" || type === "tool_call") {
    return parseToolUse(parsed, ts);
  }

  // Parse step start
  if (type === "step_start") {
    const sessionId = asString(parsed.sessionId) || asString(parsed.sessionID);
    return [
      {
        kind: "system",
        ts,
        text: `step started${sessionId ? ` (${sessionId})` : ""}`,
      },
    ];
  }

  // Parse step completion
  if (type === "step_completion" || type === "step_finish" || type === "completion") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens) || asRecord(parsed.usage);
    const cache = asRecord(tokens?.cache) || asRecord(tokens?.cached);
    const reason = asString(part?.reason, "step") || asString(parsed.status, "step");
    const output = asNumber(tokens?.output, 0) || asNumber(tokens?.output_tokens, 0);
    const input = asNumber(tokens?.input, 0) || asNumber(tokens?.input_tokens, 0);
    const cached = asNumber(cache?.read, 0) || asNumber(cache?.cached_tokens, 0) || asNumber(tokens?.cached_input_tokens, 0);
    const cost = asNumber(part?.cost, 0) || asNumber(parsed.cost, 0) || asNumber(parsed.cost_usd, 0);
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: input,
        outputTokens: output,
        cachedTokens: cached,
        costUsd: cost,
        subtype: reason,
        isError: false,
        errors: [],
      },
    ];
  }

  // Parse error
  if (type === "error" || type === "failure") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.reason);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
