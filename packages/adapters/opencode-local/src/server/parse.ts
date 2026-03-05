import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

function asErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "") || asString(rec.error, "") || asString(rec.code, "");
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let totalCostUsd = 0;
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

    const foundSession = asString(event.sessionID, "").trim();
    if (foundSession) sessionId = foundSession;

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
      usage.outputTokens += asNumber(tokens.output, 0);
      totalCostUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "error") {
      const part = parseObject(event.part);
      const msg = asErrorText(event.message ?? part.message ?? event.error ?? part.error).trim();
      if (msg) errorMessage = msg;
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

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\s+.*\s+not\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror/i.test(
    haystack,
  );
}
