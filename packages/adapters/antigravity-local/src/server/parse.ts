// Structured output parser for Antigravity stream-json CLI events

import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

// Parsed result structure returned by parseAntigravityJsonl
export interface ParsedAntigravityRun {
  sessionId: string | null;
  summary: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    thinkingTokens?: number;
    totalTokens?: number;
  };
  costUsd: number | null;
  errorMessage: string | null;
  resultEvent: Record<string, unknown> | null;
  status: string | null;
}

// Safely extracts error text from a message or error record
function asErrorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const rec = parseObject(value);
  const message =
    asString(rec.message, "") ||
    asString(rec.error, "") ||
    asString(rec.code, "") ||
    asString(rec.detail, "");
  if (message) return message.trim();
  try {
    const serialized = JSON.stringify(rec);
    return serialized === "{}" ? "" : serialized;
  } catch {
    return "";
  }
}

// Extracts usage token counts from an Antigravity usage record
function extractUsage(usageRaw: unknown): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
} {
  const usage = parseObject(usageRaw);
  const inputTokens = asNumber(
    usage.input_tokens,
    asNumber(usage.inputTokens, asNumber(usage.promptTokenCount, 0)),
  );
  const cachedInputTokens = asNumber(
    usage.cache_read_tokens,
    asNumber(usage.cached_input_tokens, asNumber(usage.cachedTokens, 0)),
  );
  const outputTokens = asNumber(
    usage.output_tokens,
    asNumber(usage.outputTokens, asNumber(usage.candidatesTokenCount, 0)),
  );
  const thinkingTokens = asNumber(
    usage.thinking_tokens,
    asNumber(usage.thinkingTokens, 0),
  );
  const totalTokens = asNumber(
    usage.total_tokens,
    asNumber(usage.totalTokens, inputTokens + outputTokens),
  );
  return { inputTokens, cachedInputTokens, outputTokens, thinkingTokens, totalTokens };
}

// Parses newline-delimited stream-json output from Antigravity CLI
export function parseAntigravityJsonl(stdout: string): ParsedAntigravityRun {
  let sessionId: string | null = null;
  const assistantDeltas: string[] = [];
  let finalResponse: string | null = null;
  let errorMessage: string | null = null;
  let resultEvent: Record<string, unknown> | null = null;
  let runStatus: string | null = null;
  let costUsd: number | null = null;

  let latestUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    totalTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Defensively parse line; ignore non-JSON lines such as warning banners or logs
    const event = parseJson(line);
    if (!event) continue;

    // Check for conversation identity in root event fields
    const directSessionId =
      asString(event.conversation_id, "").trim() ||
      asString(event.conversationId, "").trim() ||
      asString(event.session_id, "").trim() ||
      asString(event.sessionId, "").trim();
    if (directSessionId) {
      sessionId = directSessionId;
    }

    const eventName = asString(event.event, asString(event.type, "")).trim().toLowerCase();

    // Event: init -> captures conversation ID and environment tools
    if (eventName === "init") {
      const initObj = parseObject(event.init);
      const initSessionId =
        asString(event.conversation_id, "").trim() ||
        asString(initObj.conversation_id, "").trim();
      if (initSessionId) sessionId = initSessionId;
      continue;
    }

    // Event: step_update -> captures intermediate assistant deltas and usage
    if (eventName === "step_update") {
      const stepUpdate = parseObject(event.step_update ?? event);
      const stepSessionId = asString(stepUpdate.conversation_id, "").trim();
      if (stepSessionId) sessionId = stepSessionId;

      const stepType = asString(stepUpdate.step_type, "").trim().toLowerCase();
      const textDelta = asString(stepUpdate.text_delta, "");
      if (stepType === "agent_response" && textDelta) {
        assistantDeltas.push(textDelta);
      }

      if (stepUpdate.usage) {
        latestUsage = extractUsage(stepUpdate.usage);
      }
      continue;
    }

    // Event: result -> final run disposition, complete response, usage, and status
    if (eventName === "result") {
      resultEvent = event;
      const resultObj = parseObject(event.result ?? event);
      const resultSessionId = asString(resultObj.conversation_id, "").trim();
      if (resultSessionId) sessionId = resultSessionId;

      runStatus = asString(resultObj.status, "").trim();
      const response = asString(resultObj.response, "");
      if (response) {
        finalResponse = response;
      }

      if (resultObj.usage) {
        latestUsage = extractUsage(resultObj.usage);
      }

      const isError =
        runStatus.toUpperCase() === "ERROR" ||
        runStatus.toUpperCase() === "FAILURE" ||
        resultObj.is_error === true ||
        Boolean(resultObj.error);

      if (isError) {
        const err = asErrorText(resultObj.error ?? resultObj.message ?? response);
        errorMessage = err || `Antigravity run reported status: ${runStatus || "ERROR"}`;
      }

      costUsd = asNumber(resultObj.cost_usd, asNumber(resultObj.total_cost_usd, 0)) || null;
      continue;
    }

    // Event: error -> direct error payload
    if (eventName === "error") {
      const err = asErrorText(event.error ?? event.message ?? event.detail);
      if (err) errorMessage = err;
      continue;
    }
  }

  const summary = (finalResponse !== null ? finalResponse : assistantDeltas.join("")).trim();

  return {
    sessionId,
    summary,
    usage: latestUsage,
    costUsd,
    errorMessage,
    resultEvent,
    status: runStatus,
  };
}

// Checks if the output indicates an unrecoverable conversation session that warrants retry with a fresh session
export function isAntigravitySessionUnrecoverableError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /conversation\s+.*not\s+found|conversation\s+".*"\s+not\s+found|unknown\s+conversation|session\s+.*not\s+found|cannot\s+resume|failed\s+to\s+resume|stale\s+session/i.test(
    combined,
  );
}

// Helper to check if stdout or stderr indicates an authentication error
export function isAntigravityAuthError(stdout: string, stderr: string): boolean {
  return detectAntigravityAuthRequired({ parsed: null, stdout, stderr }).requiresAuth;
}

// Detects whether the run failed due to authentication or login requirements
export function detectAntigravityAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const messages = [
    input.stdout,
    input.stderr,
    input.parsed ? asErrorText(input.parsed.error ?? input.parsed.message) : "",
  ].join("\n");

  const requiresAuth = /(?:not\s+authenticated|authenticate|login\s+required|unauthorized|invalid\s+credentials|agy\s+auth|agy\s+login|api[_ ]?key\s+missing)/i.test(
    messages,
  );
  return { requiresAuth };
}

// Formats a concise description of an Antigravity failure from result event
export function describeAntigravityFailure(resultEvent: Record<string, unknown>): string | null {
  const resultObj = parseObject(resultEvent.result ?? resultEvent);
  const status = asString(resultObj.status, "");
  const error = asErrorText(resultObj.error ?? resultObj.message);

  const parts = ["Antigravity run failed"];
  if (status) parts.push(`status=${status}`);
  if (error) parts.push(error);
  return parts.length > 1 ? parts.join(": ") : null;
}
