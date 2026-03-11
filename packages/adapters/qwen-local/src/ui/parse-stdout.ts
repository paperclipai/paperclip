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

function flattenText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n").trim();
  const record = asRecord(value);
  if (!record) return "";
  return (
    asString(record.text).trim() ||
    asString(record.content).trim() ||
    flattenText(record.message) ||
    flattenText(record.parts) ||
    ""
  );
}

export function parseQwenStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  if (type === "system") {
    const sessionId = asString(parsed.sessionId) || asString(parsed.session_id) || asString(parsed.id);
    const model = asString(parsed.model);
    if (sessionId && model) return [{ kind: "init", ts, model, sessionId }];
    return [{ kind: "system", ts, text: flattenText(parsed.message) || line }];
  }

  if (type === "assistant" || type === "text") {
    const text =
      flattenText(parsed.text) ||
      flattenText(parsed.content) ||
      flattenText(parsed.message) ||
      flattenText(parsed.part);
    return text ? [{ kind: "assistant", ts, text }] : [];
  }

  if (type === "tool_call") {
    return [
      {
        kind: "tool_call",
        ts,
        name: asString(parsed.name, "tool"),
        input: parsed.input ?? {},
      },
    ];
  }

  if (type === "tool_result") {
    const content = flattenText(parsed.content) || flattenText(parsed.output) || line;
    return [
      {
        kind: "tool_result",
        ts,
        toolUseId: asString(parsed.toolUseId) || asString(parsed.id, "tool"),
        content,
        isError: parsed.is_error === true || parsed.isError === true,
      },
    ];
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage);
    return [
      {
        kind: "result",
        ts,
        text: flattenText(parsed.summary) || flattenText(parsed.message) || "result",
        inputTokens:
          asNumber(usage?.inputTokens, 0) ||
          asNumber(usage?.input_tokens, 0) ||
          asNumber(usage?.promptTokens, 0),
        outputTokens:
          asNumber(usage?.outputTokens, 0) ||
          asNumber(usage?.output_tokens, 0) ||
          asNumber(usage?.completionTokens, 0),
        cachedTokens:
          asNumber(usage?.cachedInputTokens, 0) ||
          asNumber(usage?.cached_input_tokens, 0),
        costUsd:
          asNumber(usage?.costUsd, 0) ||
          asNumber(usage?.cost_usd, 0) ||
          asNumber(parsed.costUsd, 0) ||
          asNumber(parsed.cost, 0),
        subtype: asString(parsed.subtype, "result"),
        isError: parsed.is_error === true || parsed.isError === true,
        errors: flattenText(parsed.error) ? [flattenText(parsed.error)] : [],
      },
    ];
  }

  if (type === "error") {
    return [{ kind: "stderr", ts, text: flattenText(parsed.error) || flattenText(parsed.message) || line }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
