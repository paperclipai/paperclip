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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseGoogleAdkStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = safeJsonParse(line.trim());
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const record = asRecord(parsed);
  if (!record) return [{ kind: "stdout", ts, text: line }];

  const content = asRecord(record.content);
  const role = asString(content?.role, "");
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const entries: TranscriptEntry[] = [];

  for (const partRaw of parts) {
    const part = asRecord(partRaw);
    if (!part) continue;

    const text = asString(part.text, "").trim();
    if (text) {
      entries.push({
        kind: role === "model" ? "assistant" : "stdout",
        ts,
        text,
      });
    }

    const functionCall = asRecord(part.functionCall);
    if (functionCall) {
      entries.push({
        kind: "tool_call",
        ts,
        name: asString(functionCall.name, "tool"),
        toolUseId: asString(functionCall.id, asString(functionCall.name, "tool")),
        input: functionCall.args ?? {},
      });
    }

    const functionResponse = asRecord(part.functionResponse);
    if (functionResponse) {
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: asString(functionResponse.id, asString(functionResponse.name, "tool")),
        toolName: asString(functionResponse.name, "tool"),
        content: stringifyUnknown(functionResponse.response ?? functionResponse),
        isError: false,
      });
    }
  }

  if (entries.length > 0) return entries;
  return [{ kind: "stdout", ts, text: line }];
}
