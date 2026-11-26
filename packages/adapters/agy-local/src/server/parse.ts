import type { UsageSummary } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface ParsedAgyStream {
  conversationId: string | null;
  model: string | null;
  summary: string;
  status: string | null;
  errorMessage: string | null;
  usage: UsageSummary | null;
}

/**
 * Parse `agy -p --output-format stream-json` output (NDJSON). Events:
 *   init         -> conversation_id, model
 *   step_update  -> agent_response steps carry text_delta chunks
 *   result       -> final status, full response, aggregate usage
 */
export function parseAgyStreamJson(stdout: string): ParsedAgyStream {
  let conversationId: string | null = null;
  let model: string | null = null;
  let streamedText = "";
  let finalResponse: string | null = null;
  let status: string | null = null;
  let errorMessage: string | null = null;
  let usage: UsageSummary | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown> | null = null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (!event) continue;

    if (event.event === "init") {
      conversationId = asString(event.conversation_id) ?? conversationId;
      model = asString(asRecord(event.init)?.model) ?? model;
      continue;
    }

    if (event.event === "step_update") {
      const step = asRecord(event.step_update);
      if (!step) continue;
      conversationId = asString(step.conversation_id) ?? conversationId;
      if (step.step_type === "agent_response") {
        const delta = asString(step.text_delta);
        if (delta) streamedText += delta;
      }
      continue;
    }

    if (event.event === "result") {
      const result = asRecord(event.result);
      if (!result) continue;
      conversationId = asString(result.conversation_id) ?? conversationId;
      status = asString(result.status) ?? status;
      finalResponse = asString(result.response) ?? finalResponse;
      const error = asString(result.error) ?? asString(result.error_message) ?? asString(result.message);
      if (error && status !== "SUCCESS") errorMessage = error;
      const rawUsage = asRecord(result.usage);
      if (rawUsage) {
        usage = {
          inputTokens: asNumber(rawUsage.input_tokens),
          // Thinking tokens are billed as output.
          outputTokens: asNumber(rawUsage.output_tokens) + asNumber(rawUsage.thinking_tokens),
          cachedInputTokens: asNumber(rawUsage.cache_read_tokens),
        };
      }
    }
  }

  if (status && status !== "SUCCESS" && !errorMessage) {
    errorMessage = `agy finished with status ${status}`;
  }

  return {
    conversationId,
    model,
    summary: (finalResponse ?? streamedText).trim(),
    status,
    errorMessage,
    usage,
  };
}

/** agy warns and silently starts a new conversation when the id is unknown. */
export function isAgyUnknownSessionError(stdout: string, stderr: string): boolean {
  return /conversation\s+"[^"]*"\s+not found/i.test(`${stdout}\n${stderr}`);
}

/**
 * agy warns and starts a new conversation when the saved one is missing. If that
 * attempt already reached a result, the task ran; retrying would repeat it.
 */
export function shouldRetryFreshConversation(
  parsed: { status: string | null },
  stdout: string,
  stderr: string,
): boolean {
  return isAgyUnknownSessionError(stdout, stderr) && parsed.status === null;
}

const AUTH_RE = /(not (logged|signed) in|unauthenticated|please (log|sign) in|login required|authentication (required|failed)|invalid credentials|token (expired|invalid))/i;

export function detectAgyAuthRequired(stdout: string, stderr: string): boolean {
  return AUTH_RE.test(`${stdout}\n${stderr}`);
}
