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

function extractSessionId(record: Record<string, unknown>): string {
  const direct =
    asString(record.sessionId).trim() ||
    asString(record.session_id).trim() ||
    asString(record.sessionID).trim();
  if (direct) return direct;
  const session = asRecord(record.session);
  return asString(session?.id).trim() || asString(session?.sessionId).trim();
}

function extractAssistantText(record: Record<string, unknown>): string {
  const direct =
    asString(record.summary).trim() ||
    asString(record.output_text).trim() ||
    asString(record.text).trim();
  if (direct) return direct;
  const message = asRecord(record.message);
  const role = asString(message?.role).toLowerCase();
  if (role === "assistant" || !role) {
    const content = asString(message?.content).trim() || asString(message?.text).trim();
    if (content) return content;
  }
  const response = asRecord(record.response);
  const responseText = asString(response?.output_text).trim();
  if (responseText) return responseText;
  return "";
}

function extractError(record: Record<string, unknown>): string {
  const direct = asString(record.error).trim();
  if (direct) return direct;
  const errorObj = asRecord(record.error);
  const nested = asString(errorObj?.message).trim() || asString(errorObj?.code).trim();
  if (nested) return nested;
  if (asString(record.type).toLowerCase().includes("error")) {
    return asString(record.message).trim();
  }
  return "";
}

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const entries: TranscriptEntry[] = [];
  const sessionId = extractSessionId(parsed);
  if (sessionId) {
    entries.push({
      kind: "init",
      ts,
      model: asString(parsed.model, "copilot"),
      sessionId,
    });
  }

  const text = extractAssistantText(parsed);
  if (text) {
    entries.push({ kind: "assistant", ts, text });
  }

  const usageObj = asRecord(parsed.usage);
  if (usageObj) {
    entries.push({
      kind: "result",
      ts,
      text: asString(parsed.summary, ""),
      inputTokens: asNumber(usageObj.input_tokens, asNumber(usageObj.prompt_tokens, 0)),
      outputTokens: asNumber(usageObj.output_tokens, asNumber(usageObj.completion_tokens, 0)),
      cachedTokens: asNumber(usageObj.cached_input_tokens, 0),
      costUsd: asNumber(parsed.costUsd, asNumber(parsed.cost_usd, asNumber(parsed.cost, 0))),
      subtype: asString(parsed.type, "result"),
      isError: false,
      errors: [],
    });
  }

  const error = extractError(parsed);
  if (error) {
    entries.push({ kind: "stderr", ts, text: error });
  }

  return entries.length > 0 ? entries : [{ kind: "stdout", ts, text: line }];
}
