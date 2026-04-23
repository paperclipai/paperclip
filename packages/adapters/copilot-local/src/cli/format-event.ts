import pc from "picocolors";

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

export function printCopilotStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const sessionId =
    asString(parsed.sessionId).trim() ||
    asString(parsed.session_id).trim() ||
    asString(parsed.sessionID).trim();
  if (sessionId) {
    console.log(pc.blue(`session: ${sessionId}`));
  }

  const assistantText = extractAssistantText(parsed);
  if (assistantText) {
    console.log(pc.green(`assistant: ${assistantText}`));
  }

  const usage = asRecord(parsed.usage);
  if (usage) {
    const input = asNumber(usage.input_tokens, asNumber(usage.prompt_tokens, 0));
    const output = asNumber(usage.output_tokens, asNumber(usage.completion_tokens, 0));
    const cached = asNumber(usage.cached_input_tokens, 0);
    const cost = asNumber(parsed.costUsd, asNumber(parsed.cost_usd, asNumber(parsed.cost, 0)));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
  }

  const error = extractError(parsed);
  if (error) {
    console.log(pc.red(`error: ${error}`));
  }
}
