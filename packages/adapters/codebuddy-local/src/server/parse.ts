import { asNumber, asString, parseObject } from "@penclipai/adapter-utils/server-utils";
import { normalizeCodeBuddyStreamLine } from "../shared/stream.js";

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

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const messages = value
      .map((entry) => asErrorText(entry).trim())
      .filter(Boolean);
    return messages.join("; ");
  }
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  const nestedErrors = Array.isArray(rec.errors)
    ? rec.errors
      .map((entry) => asErrorText(entry).trim())
      .filter(Boolean)
    : [];
  if (nestedErrors.length > 0) return nestedErrors.join("; ");
  try {
    const stringified = JSON.stringify(rec);
    return stringified === "{}" ? "" : stringified;
  } catch {
    return "";
  }
}

function pickErrorText(...values: unknown[]): string {
  for (const value of values) {
    const text = asErrorText(value).trim();
    if (text) return text;
  }
  return "";
}

function collectAssistantText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const rec = parseObject(message);
  const direct = asString(rec.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(rec.content) ? rec.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text") {
      const text = asString(part.text, "").trim();
      if (text) lines.push(text);
    }
  }

  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.sessionID, "").trim() ||
    null
  );
}

function collectEvents(stdout: string): Array<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  const whole = safeJsonParse(trimmed);
  if (Array.isArray(whole)) {
    return whole.map((entry) => asRecord(entry)).filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  const single = asRecord(whole);
  if (single) return [single];

  const events: Array<Record<string, unknown>> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = normalizeCodeBuddyStreamLine(rawLine).line;
    if (!line) continue;
    const parsed = safeJsonParse(line);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const record = asRecord(entry);
        if (record) events.push(record);
      }
      continue;
    }
    const record = asRecord(parsed);
    if (record) events.push(record);
  }
  return events;
}

export function parseCodeBuddyJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const event of collectEvents(stdout)) {
    const foundSession = readSessionId(event);
    if (foundSession) sessionId = foundSession;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectAssistantText(event.message));
      continue;
    }

    if (type === "result") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens += asNumber(
        usageObj.input_tokens,
        asNumber(usageObj.inputTokens, 0),
      );
      usage.cachedInputTokens += asNumber(
        usageObj.cached_input_tokens,
        asNumber(usageObj.cachedInputTokens, asNumber(usageObj.cache_read_input_tokens, 0)),
      );
      usage.outputTokens += asNumber(
        usageObj.output_tokens,
        asNumber(usageObj.outputTokens, 0),
      );
      totalCostUsd += asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, 0)));

      const isError = event.is_error === true || asString(event.subtype, "").toLowerCase() === "error";
      const resultText = asString(event.result, "").trim();
      if (resultText && messages.length === 0) {
        messages.push(resultText);
      }
      if (isError) {
        const resultError = pickErrorText(event.error, event.message, event.result, event.errors);
        if (resultError) errorMessage = resultError;
      }
      continue;
    }

    if (type === "error") {
      const message = pickErrorText(event.message, event.error, event.detail, event.errors);
      if (message) errorMessage = message;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const message = pickErrorText(event.message, event.error, event.detail, event.errors);
        if (message) errorMessage = message;
      }
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd: totalCostUsd > 0 ? totalCostUsd : null,
    errorMessage,
  };
}

export function isCodeBuddyUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|no\s+conversation\s+found\s+with\s+session\s+id/i.test(
    haystack,
  );
}
