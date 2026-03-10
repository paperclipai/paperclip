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
  const state = asRecord(part.state);
  const input = state?.input ?? {};
  const callEntry: TranscriptEntry = {
    kind: "tool_call",
    ts,
    name: toolName,
    input,
  };

  const status = asString(state?.status);
  if (status !== "completed" && status !== "error") return [callEntry];

  const rawOutput =
    asString(state?.output) ||
    asString(state?.error) ||
    asString(part.title) ||
    `${toolName} ${status}`;

  const metadata = asRecord(state?.metadata);
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
      isError: status === "error",
    },
  ];
}

export function parseOpenCodeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const type = asString(parsed.type);

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "assistant", ts, text }];
  }

  if (type === "reasoning") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text).trim();
    if (!text) return [];
    return [{ kind: "thinking", ts, text }];
  }

  if (type === "tool_use") {
    return parseToolUse(parsed, ts);
  }

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    return [
      {
        kind: "system",
        ts,
        text: `step started${sessionId ? ` (${sessionId})` : ""}`,
      },
    ];
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = asString(part?.reason, "step");
    const output = asNumber(tokens?.output, 0) + asNumber(tokens?.reasoning, 0);
    return [
      {
        kind: "result",
        ts,
        text: reason,
        inputTokens: asNumber(tokens?.input, 0),
        outputTokens: output,
        cachedTokens: asNumber(cache?.read, 0),
        costUsd: asNumber(part?.cost, 0),
        subtype: reason,
        isError: false,
        errors: [],
      },
    ];
  }

  if (type === "error") {
    const text = errorText(parsed.error ?? parsed.message);
    return [{ kind: "stderr", ts, text: text || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
