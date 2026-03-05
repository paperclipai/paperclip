import { asString, asNumber, parseJson } from "@paperclipai/adapter-utils/server-utils";

export interface GeminiJsonResult {
  sessionId: string | null;
  summary: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  };
  errorMessage: string | null;
}

/**
 * Parse Gemini CLI JSON output (--output-format json).
 * Returns a single structured result with session ID, response, and usage.
 */
export function parseGeminiJson(stdout: string): GeminiJsonResult {
  const parsed = parseJson(stdout.trim());
  if (!parsed) {
    return {
      sessionId: null,
      summary: stdout.trim(),
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      errorMessage: null,
    };
  }

  const sessionId = asString(parsed.session_id, "") || null;
  const response = asString(parsed.response, "");
  const stats = typeof parsed.stats === "object" && parsed.stats !== null ? parsed.stats as Record<string, unknown> : {};
  const models = typeof stats.models === "object" && stats.models !== null ? stats.models as Record<string, unknown> : {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  for (const modelData of Object.values(models)) {
    if (typeof modelData !== "object" || modelData === null) continue;
    const tokens = (modelData as Record<string, unknown>).tokens;
    if (typeof tokens !== "object" || tokens === null) continue;
    const t = tokens as Record<string, unknown>;
    inputTokens += asNumber(t.input, 0);
    outputTokens += asNumber(t.candidates, 0);
    cachedTokens += asNumber(t.cached, 0);
  }

  return {
    sessionId,
    summary: response,
    usage: { inputTokens, cachedInputTokens: cachedTokens, outputTokens },
    errorMessage: null,
  };
}

/**
 * Parse Gemini CLI stream-json output (--output-format stream-json).
 * Parses JSONL lines and extracts session, messages, and usage.
 */
export function parseGeminiStreamJson(stdout: string): GeminiJsonResult {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const eventType = asString(event.type, "");

    if (eventType === "init") {
      sessionId = asString(event.session_id, "") || sessionId;
      continue;
    }

    if (eventType === "message") {
      const role = asString(event.role, "");
      const content = asString(event.content, "");
      if (role === "assistant" && content) {
        messages.push(content);
      }
      continue;
    }

    if (eventType === "error") {
      const msg = asString(event.message, asString(event.error, "")).trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (eventType === "result") {
      const status = asString(event.status, "");
      if (status !== "success" && status) {
        const msg = asString(event.error, asString(event.message, "")).trim();
        if (msg) errorMessage = msg;
      }
      const stats = typeof event.stats === "object" && event.stats !== null ? event.stats as Record<string, unknown> : {};
      usage.inputTokens = asNumber(stats.input_tokens, asNumber(stats.input, usage.inputTokens));
      usage.outputTokens = asNumber(stats.output_tokens, usage.outputTokens);
      usage.cachedInputTokens = asNumber(stats.cached, usage.cachedInputTokens);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    errorMessage,
  };
}

export function isGeminiSessionNotFoundError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return /session .* not found|invalid session|no such session|cannot resume/i.test(haystack);
}
