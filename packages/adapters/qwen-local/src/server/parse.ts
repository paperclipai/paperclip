import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromUnknown(entry))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (typeof value !== "object" || value === null) return "";
  const record = parseObject(value);
  return (
    asString(record.text, "").trim() ||
    asString(record.content, "").trim() ||
    asString(record.message, "").trim() ||
    textFromUnknown(record.parts) ||
    textFromUnknown(record.contentParts)
  );
}

export function parseQwenStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let costUsd = 0;
  let resultJson: Record<string, unknown> | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
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

    const type = asString(event.type, "");
    const subtype = asString(event.subtype, "");
    const usageRecord = parseObject(event.usage);
    const metrics = parseObject(event.metrics);

    const currentSessionId =
      asString(event.sessionId, "").trim() ||
      asString(event.session_id, "").trim() ||
      asString(event.id, "").trim();
    if ((type === "system" || subtype === "session_start") && currentSessionId) {
      sessionId = currentSessionId;
    }

    model ||= asString(event.model, "").trim() || null;
    provider ||= asString(event.provider, "").trim() || null;

    if (type === "assistant" || type === "text") {
      const text =
        textFromUnknown(event.text) ||
        textFromUnknown(event.content) ||
        textFromUnknown(event.message) ||
        textFromUnknown(event.part);
      if (text) messages.push(text);
      continue;
    }

    if (type === "result") {
      resultJson = event;
      usage.inputTokens +=
        asNumber(usageRecord.inputTokens, 0) ||
        asNumber(usageRecord.input_tokens, 0) ||
        asNumber(usageRecord.promptTokens, 0) ||
        asNumber(metrics.inputTokens, 0);
      usage.outputTokens +=
        asNumber(usageRecord.outputTokens, 0) ||
        asNumber(usageRecord.output_tokens, 0) ||
        asNumber(usageRecord.completionTokens, 0) ||
        asNumber(metrics.outputTokens, 0);
      usage.cachedInputTokens +=
        asNumber(usageRecord.cachedInputTokens, 0) ||
        asNumber(usageRecord.cached_input_tokens, 0);
      costUsd +=
        asNumber(usageRecord.costUsd, 0) ||
        asNumber(usageRecord.cost_usd, 0) ||
        asNumber(event.costUsd, 0) ||
        asNumber(event.cost, 0);
      const errorText =
        textFromUnknown(event.error) ||
        (event.is_error === true || event.isError === true ? textFromUnknown(event.message) : "");
      if (errorText) errors.push(errorText);
      continue;
    }

    if (type === "error") {
      const errorText = textFromUnknown(event.error) || textFromUnknown(event.message) || line;
      if (errorText) errors.push(errorText);
      continue;
    }
  }

  return {
    sessionId,
    model,
    provider,
    usage,
    costUsd,
    resultJson,
    summary: messages.join("\n\n").trim() || null,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
  };
}

export function isQwenUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`;
  return /unknown\s+session|session\b.*\bnot\s+found|invalid\s+session|resume\b.*\bfailed|cannot\s+resume/i.test(
    haystack,
  );
}
