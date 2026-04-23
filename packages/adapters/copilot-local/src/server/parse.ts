import { asBoolean, asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

const STDERR_ERROR_RE =
  /(error|failed|not\s+logged\s+in|unauthorized|forbidden|invalid|resume failed|session not found|unknown session|denied|timed\s*out)/i;

function parseStderrFallback(stderr: string): string | null {
  const first = firstNonEmptyLine(stderr);
  if (!first) return null;
  return STDERR_ERROR_RE.test(first) ? first : null;
}

function extractPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload = parseObject(record.data);
  return Object.keys(payload).length > 0 ? payload : record;
}

function extractType(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  return normalizeText(record.type || payload.type).toLowerCase();
}

function extractSessionId(record: Record<string, unknown>, payload: Record<string, unknown>): string | null {
  const direct =
    normalizeText(payload.sessionId) ||
    normalizeText(payload.session_id) ||
    normalizeText(payload.sessionID) ||
    normalizeText(record.sessionId) ||
    normalizeText(record.session_id) ||
    normalizeText(record.sessionID);
  if (direct) return direct;
  const payloadSession = parseObject(payload.session);
  const recordSession = parseObject(record.session);
  const nested =
    normalizeText(payloadSession.id) ||
    normalizeText(payloadSession.sessionId) ||
    normalizeText(recordSession.id) ||
    normalizeText(recordSession.sessionId);
  return nested || null;
}

function extractAssistantText(
  type: string,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  if (type.includes("error")) return "";
  if (type.startsWith("session.") || type === "user.message" || type === "assistant.turn_start" || type === "assistant.turn_end") {
    return "";
  }
  if (type === "assistant.reasoning") return "";
  if (type.startsWith("tool.execution_")) return "";

  const direct =
    normalizeText(payload.content) ||
    normalizeText(payload.summary) ||
    normalizeText(payload.output_text) ||
    normalizeText(payload.text) ||
    normalizeText(record.summary) ||
    normalizeText(record.output_text) ||
    normalizeText(record.text);
  if (direct) return direct;

  const payloadMessage = parseObject(payload.message);
  const recordMessage = parseObject(record.message);
  const message = Object.keys(payloadMessage).length > 0 ? payloadMessage : recordMessage;
  const messageRole = normalizeText(message.role).toLowerCase();
  if (!messageRole || messageRole === "assistant") {
    const content = normalizeText(message.content) || normalizeText(message.text);
    if (content) return content;
  }

  const payloadResponse = parseObject(payload.response);
  const recordResponse = parseObject(record.response);
  const response = Object.keys(payloadResponse).length > 0 ? payloadResponse : recordResponse;
  const responseOutputText = normalizeText(response.output_text);
  if (responseOutputText) return responseOutputText;

  const choices = Array.isArray(payload.choices)
    ? payload.choices
    : Array.isArray(record.choices)
      ? record.choices
      : [];
  for (const rawChoice of choices) {
    const choice = parseObject(rawChoice);
    const choiceMessage = parseObject(choice.message);
    const content =
      normalizeText(choiceMessage.content) ||
      normalizeText(choiceMessage.text) ||
      normalizeText(choice.text);
    if (content) return content;
  }

  return "";
}

function readErrorValue(value: unknown): string {
  const direct = normalizeText(value);
  if (direct) return direct;
  const record = parseObject(value);
  const message =
    normalizeText(record.message) ||
    normalizeText(record.error) ||
    normalizeText(record.code) ||
    normalizeText(record.reason) ||
    normalizeText(record.content);
  if (message) return message;
  return safeStringify(value);
}

function extractError(
  type: string,
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): string {
  const directError =
    readErrorValue(payload.error) ||
    readErrorValue(record.error);
  if (directError) return directError;

  if (type === "tool.execution_complete") {
    const success = asBoolean(payload.success, true);
    if (!success) {
      return (
        readErrorValue(payload.result) ||
        readErrorValue(payload.message) ||
        "Tool execution failed."
      );
    }
  }

  if (type === "result") {
    const exitCode = asNumber(payload.exitCode, asNumber(record.exitCode, 0));
    if (exitCode !== 0) {
      return readErrorValue(payload.message) || `Copilot exited with code ${exitCode}`;
    }
  }

  if (type.includes("error")) {
    return (
      readErrorValue(payload.message) ||
      readErrorValue(record.message) ||
      safeStringify(payload) ||
      safeStringify(record)
    );
  }

  return "";
}

function applyUsageObject(
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageObj: Record<string, unknown>,
) {
  const promptTokens = asNumber(usageObj.prompt_tokens, asNumber(usageObj.promptTokens, 0));
  const inputTokens = asNumber(
    usageObj.input_tokens,
    asNumber(usageObj.inputTokens, promptTokens),
  );
  const outputTokens = asNumber(
    usageObj.output_tokens,
    asNumber(
      usageObj.outputTokens,
      asNumber(usageObj.completion_tokens, asNumber(usageObj.completionTokens, 0)),
    ),
  );
  const cachedDetails = parseObject(usageObj.prompt_tokens_details);
  const cachedInputTokens = asNumber(
    usageObj.cached_input_tokens,
    asNumber(
      usageObj.cachedInputTokens,
      asNumber(cachedDetails.cached_tokens, asNumber(cachedDetails.cachedTokens, 0)),
    ),
  );

  usage.inputTokens = Math.max(usage.inputTokens, inputTokens);
  usage.outputTokens = Math.max(usage.outputTokens, outputTokens);
  usage.cachedInputTokens = Math.max(usage.cachedInputTokens, cachedInputTokens);
}

function applyUsage(
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const payloadUsage = parseObject(payload.usage);
  const recordUsage = parseObject(record.usage);
  const payloadResultUsage = parseObject(parseObject(payload.result).usage);
  const recordResultUsage = parseObject(parseObject(record.result).usage);

  if (Object.keys(payloadUsage).length > 0) applyUsageObject(usage, payloadUsage);
  if (Object.keys(recordUsage).length > 0) applyUsageObject(usage, recordUsage);
  if (Object.keys(payloadResultUsage).length > 0) applyUsageObject(usage, payloadResultUsage);
  if (Object.keys(recordResultUsage).length > 0) applyUsageObject(usage, recordResultUsage);

  const inlineInputTokens = asNumber(
    payload.inputTokens,
    asNumber(payload.input_tokens, asNumber(record.inputTokens, asNumber(record.input_tokens, 0))),
  );
  const inlineOutputTokens = asNumber(
    payload.outputTokens,
    asNumber(payload.output_tokens, asNumber(record.outputTokens, asNumber(record.output_tokens, 0))),
  );
  const inlineCachedInputTokens = asNumber(
    payload.cachedInputTokens,
    asNumber(
      payload.cached_input_tokens,
      asNumber(record.cachedInputTokens, asNumber(record.cached_input_tokens, 0)),
    ),
  );

  usage.inputTokens = Math.max(usage.inputTokens, inlineInputTokens);
  usage.outputTokens = Math.max(usage.outputTokens, inlineOutputTokens);
  usage.cachedInputTokens = Math.max(usage.cachedInputTokens, inlineCachedInputTokens);
}

function extractCost(record: Record<string, unknown>, payload: Record<string, unknown>): number | null {
  const candidate = asNumber(
    payload.costUsd,
    asNumber(
      payload.cost_usd,
      asNumber(
        payload.cost,
        asNumber(record.costUsd, asNumber(record.cost_usd, asNumber(record.cost, Number.NaN))),
      ),
    ),
  );
  return Number.isFinite(candidate) ? candidate : null;
}

function parseObjects(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const value = parseJson(trimmed);
  if (value && typeof value === "object") {
    if (!Array.isArray(value)) return [value as Record<string, unknown>];
    const entries: Record<string, unknown>[] = [];
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        entries.push(item as Record<string, unknown>);
      }
    }
    if (entries.length > 0) return entries;
  }
  const parsed: Record<string, unknown>[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lineValue = parseJson(line);
    if (!lineValue || typeof lineValue !== "object" || Array.isArray(lineValue)) continue;
    parsed.push(lineValue as Record<string, unknown>);
  }
  return parsed;
}

export function parseCopilotJsonOutput(stdout: string, stderr = "") {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd: number | null = null;
  const records = parseObjects(stdout);

  if (records.length === 0) {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        sessionId,
        summary: "",
        usage,
        costUsd,
        errorMessage: parseStderrFallback(stderr),
      };
    }

    const first = firstNonEmptyLine(trimmed);
    const looksLikeError =
      /(error|failed|not\s+logged\s+in|unauthorized|forbidden|invalid|resume\s+failed|invalid\s+resume|session\s+not\s+found|unknown\s+session|no\s+such\s+session)/i.test(first);
    return {
      sessionId,
      summary: looksLikeError ? "" : trimmed,
      usage,
      costUsd,
      errorMessage: looksLikeError ? first : null,
    };
  }

  for (const record of records) {
    const payload = extractPayload(record);
    const type = extractType(record, payload);
    const nextSessionId = extractSessionId(record, payload);
    if (nextSessionId) sessionId = nextSessionId;

    const text = extractAssistantText(type, record, payload);
    if (text) messages.push(text);

    const error = extractError(type, record, payload);
    if (error) errors.push(error);

    applyUsage(usage, record, payload);

    const nextCost = extractCost(record, payload);
    if (nextCost !== null) {
      costUsd = costUsd === null ? nextCost : Math.max(costUsd, nextCost);
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : parseStderrFallback(stderr),
  };
}

export function isCopilotUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|invalid\s+resume|resume\b.*\bfailed|stale\s+session|no\s+such\s+session|no\s+session\s+or\s+task\s+matched|invalid\s+value.+--resume/i.test(
    haystack,
  );
}
