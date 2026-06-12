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

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
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

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
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
    toolErrors,
  };
}

export interface OpenCodeQuotaExhaustion {
  provider: string | null;
  code: string | null;
  message: string | null;
}

/**
 * Detect the LLM proxy's terminal quota-exhaustion block signal (ALL-510) in an
 * OpenCode run's output. The proxy returns HTTP 402 with a structured body
 * `{ "error": { "type": "quota_exhausted", "provider", "code", "message" }, "blocked": true }`
 * for non-transient credit/quota exhaustion (OpenRouter-style 402, or MiniMax
 * code 2056 — which can ride on an HTTP 200 body). OpenCode surfaces that error
 * payload through its JSONL `error` events and/or stderr, so we scan both for the
 * structured marker and, when present, lift the provider/code/message out of the
 * embedded JSON. Returns null when the failure is not a quota block (e.g. a plain
 * transient 429), so the runner can keep its normal retry/backoff behaviour.
 */
export function detectOpenCodeQuotaExhaustion(
  stdout: string,
  stderr: string,
): OpenCodeQuotaExhaustion | null {
  const haystack = `${stdout}\n${stderr}`;

  // Primary, unambiguous markers from the proxy's structured 402 body.
  const hasStructuredMarker =
    /"type"\s*:\s*"quota_exhausted"/i.test(haystack) ||
    /"blocked"\s*:\s*true/i.test(haystack) ||
    /\bquota[_\s-]?exhausted\b/i.test(haystack);

  // MiniMax code 2056 / OpenRouter-style 402 credit exhaustion, which can arrive
  // without the structured wrapper depending on how OpenCode renders the error.
  const hasMiniMaxQuotaCode = /\b(?:status_code|code)\b[^0-9]{0,12}2056\b/i.test(haystack);
  const hasPaymentRequired =
    /\b402\b[^\n]{0,80}(?:payment\s+required|quota|credit|insufficient|exhaust)/i.test(haystack) ||
    /(?:payment\s+required|insufficient\s+(?:credit|funds|balance)|usage\s+limit\s+reached)[^\n]{0,80}\b402\b/i.test(
      haystack,
    );

  if (!hasStructuredMarker && !hasMiniMaxQuotaCode && !hasPaymentRequired) {
    return null;
  }

  // Best-effort extraction of provider/code/message from the embedded structured
  // body. OpenCode frequently nests the proxy's JSON inside its own error event as
  // an escaped string (e.g. `{"error":{"message":"Provider 402: {\"error\":{\"type\":
  // \"quota_exhausted\",...},\"blocked\":true}"}}`), so a single JSON.parse of the
  // outer object never reaches the inner fields. Normalize escaped quotes, then
  // isolate the flat `quota_exhausted` error object and lift its fields by regex.
  let provider: string | null = null;
  let code: string | null = null;
  let message: string | null = null;

  const normalized = haystack.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const errorObject =
    normalized.match(/"error"\s*:\s*\{[^{}]*"type"\s*:\s*"quota_exhausted"[^{}]*\}/i)?.[0] ??
    normalized.match(/\{[^{}]*"type"\s*:\s*"quota_exhausted"[^{}]*\}/i)?.[0] ??
    null;
  if (errorObject) {
    provider = errorObject.match(/"provider"\s*:\s*"([^"]*)"/i)?.[1]?.trim() || null;
    const codeMatch = errorObject.match(/"code"\s*:\s*(?:"([^"]*)"|(\d+))/i);
    code = (codeMatch?.[1] ?? codeMatch?.[2])?.trim() || null;
    message = errorObject.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/i)?.[1]?.trim() || null;
  }

  if (!code && hasMiniMaxQuotaCode) code = "2056";
  if (!code && hasPaymentRequired) code = "402";

  return { provider, code, message };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
