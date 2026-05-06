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

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type).toLowerCase();
  const role = asString(parsed.role).toLowerCase();
  if (type === "error" || role === "error" || parsed.is_error === true) {
    return [{
      kind: "stderr",
      ts,
      text: asString(parsed.message) || stringifyUnknown(parsed.error ?? parsed),
    }];
  }

  if (role === "assistant" || type === "assistant" || type === "message" || type === "result") {
    const text =
      asString(parsed.text) ||
      asString(parsed.content) ||
      asString(parsed.response) ||
      asString(parsed.result) ||
      asString(asRecord(parsed.message)?.text);
    if (text) return [{ kind: "assistant", ts, text }];
  }

  if (type === "tool_call") {
    return [{
      kind: "tool_call",
      ts,
      name: asString(parsed.name) || "tool",
      input: parsed.input ?? parsed.arguments ?? {},
    }];
  }

  return [{ kind: "system", ts, text: stringifyUnknown(parsed) }];
}
