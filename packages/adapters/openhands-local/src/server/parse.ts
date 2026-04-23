import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenHandsJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    // OpenHands uses different field names, try multiple variants
    const currentSessionId = 
      asString(event.sessionId, "").trim() ||
      asString(event.sessionID, "").trim() ||
      asString(event.session_id, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "") || asString(event.event_type, "");

    // Parse message/thinking text
    if (type === "message" || type === "thinking" || type === "text") {
      const text = asString(event.message, "").trim() || 
                   asString(event.text, "").trim() ||
                   asString(event.content, "").trim();
      if (text) messages.push(text);
      continue;
    }

    // Parse token usage from step completion
    if (type === "step_completion" || type === "step_finish" || type === "completion") {
      const tokens = parseObject(event.tokens) || parseObject(event.usage);
      const cache = parseObject(tokens.cache) || parseObject(tokens.cached);
      usage.inputTokens += asNumber(tokens.input, 0) || asNumber(tokens.input_tokens, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0) || asNumber(cache.cached_tokens, 0) || asNumber(tokens.cached_input_tokens, 0);
      usage.outputTokens += asNumber(tokens.output, 0) || asNumber(tokens.output_tokens, 0);
      costUsd += asNumber(event.cost, 0) || asNumber(event.cost_usd, 0);
      continue;
    }

    // Parse tool errors
    if (type === "tool_use" || type === "tool_call") {
      const state = parseObject(event.state) || parseObject(event.status);
      if (asString(state.status, "") === "error" || asString(state, "") === "error") {
        const text = asString(state.error, "").trim() || 
                     asString(event.error, "").trim();
        if (text) errors.push(text);
      }
      continue;
    }

    // Parse general errors
    if (type === "error" || type === "failure") {
      const text = errorText(event.error ?? event.message ?? event.reason).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function isOpenHandsUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session|session.*does not exist/i.test(
    haystack,
  );
}
