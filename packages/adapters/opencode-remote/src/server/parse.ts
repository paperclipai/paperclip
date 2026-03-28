import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export interface OpenCodeParsedResponse {
  summary: string | null;
  errorMessage: string | null;
  modelID: string | null;
  providerID: string | null;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
}

export function parseOpenCodeResponse(response: unknown): OpenCodeParsedResponse {
  const rec = parseObject(response);
  const info = parseObject(rec.info);
  const parts = Array.isArray(rec.parts) ? rec.parts : [];

  // Extract error from info
  const infoError = parseObject(info.error);
  const errorName = asString(infoError.name, "");
  const errorData = parseObject(infoError.data);
  const errorMessage = asString(errorData.message, "").trim();
  const hasError = Boolean(errorName || errorMessage);

  // Extract tokens from info
  const tokens = parseObject(info.tokens);
  const cache = parseObject(tokens.cache);

  const usage = {
    inputTokens: asNumber(tokens.input, 0),
    outputTokens: asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0),
    cachedInputTokens: asNumber(cache.read, 0),
  };

  const costUsd = asNumber(info.cost, 0);
  const modelID = asString(info.modelID, "").trim() || null;
  const providerID = asString(info.providerID, "").trim() || null;

  // Extract text from parts
  const textParts: string[] = [];
  for (const part of parts) {
    const p = parseObject(part);
    const type = asString(p.type, "");
    if (type === "text") {
      const text = asString(p.text, "").trim();
      if (text) textParts.push(text);
    }
  }

  // Also check for validation error response shape
  const validationError = Array.isArray(rec.error)
    ? rec.error.map((e: unknown) => asString(parseObject(e).message, "")).filter(Boolean).join("; ")
    : null;
  const success = rec.success;

  const resolvedError = hasError
    ? (errorMessage || `${errorName}: ${JSON.stringify(errorData)}`)
    : (success === false && validationError)
      ? `Validation error: ${validationError}`
      : null;

  return {
    summary: textParts.length > 0 ? textParts.join("\n\n") : null,
    errorMessage: resolvedError,
    modelID,
    providerID,
    costUsd,
    usage,
  };
}

export function isOpenCodeSessionNotFound(raw: string): boolean {
  return /session\b.*\bnot\s+found|unknown\s+session|resource\s+not\s+found|notfounderror|no session/i.test(
    raw,
  );
}
