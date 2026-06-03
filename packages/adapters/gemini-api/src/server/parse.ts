import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function collectMessageText(message: unknown): string[] {
  if (typeof message === "string") {
    const trimmed = message.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(message);
  const direct = asString(record.text, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];

  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const type = asString(part.type, "").trim();
    if (type === "output_text" || type === "text" || type === "content") {
      const text = asString(part.text, "").trim() || asString(part.content, "").trim();
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
    asString(event.checkpoint_id, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function asErrorText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  if (Object.keys(rec).length === 0) return "";
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message;
  try {
    const serialized = JSON.stringify(rec);
    return serialized === "{}" ? "" : serialized;
  } catch {
    return "";
  }
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
): void {
  const usage = parseObject(usageRaw);
  const usageMetadata = parseObject(usage.usageMetadata);
  const source = Object.keys(usageMetadata).length > 0 ? usageMetadata : usage;

  target.inputTokens += asNumber(
    source.input_tokens,
    asNumber(source.inputTokens, asNumber(source.promptTokenCount, 0)),
  );
  target.cachedInputTokens += asNumber(
    source.cached_input_tokens,
    asNumber(
      source.cachedInputTokens,
      asNumber(source.cachedContentTokenCount, asNumber(source.cached, 0)),
    ),
  );
  target.outputTokens += asNumber(
    source.output_tokens,
    asNumber(source.outputTokens, asNumber(source.candidatesTokenCount, 0)),
  );
}

function extractErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }
    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function parseGeminiApiJsonl(stdout: string): {
  sessionId: string | null;
  summary: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  costUsd: number | null;
  errorMessage: string | null;
  resultEvent: Record<string, unknown> | null;
} {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;

    const type = asString(event.type, "").trim();

    if (type === "assistant") {
      messages.push(...collectMessageText(event.message));
      continue;
    }

    if (type === "message") {
      const role = asString(event.role, "").trim().toLowerCase();
      if (role === "assistant") {
        messages.push(...collectMessageText(event.content));
      }
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      accumulateUsage(usage, event.usage ?? event.usageMetadata ?? event.stats);
      const resultText =
        asString(event.result, "").trim() ||
        asString(event.text, "").trim() ||
        asString(event.response, "").trim();
      if (resultText && messages.length === 0) messages.push(resultText);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      const status = asString(event.status, "").toLowerCase();
      const isError =
        event.is_error === true ||
        asString(event.subtype, "").toLowerCase() === "error" ||
        status === "error" ||
        status === "failed";
      if (isError) {
        const text = asErrorText(event.error ?? event.message ?? event.result).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "error") {
      const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
      if (text) errorMessage = text;
      continue;
    }

    if (type === "system") {
      const subtype = asString(event.subtype, "").trim().toLowerCase();
      if (subtype === "error") {
        const text = asErrorText(event.error ?? event.message ?? event.detail).trim();
        if (text) errorMessage = text;
      }
      continue;
    }

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish" || event.usage || event.usageMetadata) {
      accumulateUsage(usage, event.usage ?? event.usageMetadata);
      costUsd = asNumber(event.total_cost_usd, asNumber(event.cost_usd, asNumber(event.cost, costUsd ?? 0))) || costUsd;
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage,
    resultEvent,
  };
}

export function describeGeminiApiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractErrorMessages(parsed);
  const detail = errors[0] ?? "";
  const parts = ["Gemini API run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

/** Patterns that indicate a 429 / quota exhaustion from the Gemini REST API */
const QUOTA_PATTERN =
  /(?:429|QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED|capacity on this model|quota will reset|too many requests|rate[-\s]?limit)/i;

export function detectGeminiApiQuotaExhausted(input: {
  status?: number;
  body?: string;
  errorCode?: string;
}): boolean {
  if (input.status === 429) return true;
  const text = [input.body ?? "", input.errorCode ?? ""].join("\n");
  return QUOTA_PATTERN.test(text);
}
