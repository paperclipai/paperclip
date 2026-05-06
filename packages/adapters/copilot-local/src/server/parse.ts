import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  const record = parseObject(value);
  const direct =
    asString(record.text, "").trim() ||
    asString(record.content, "").trim() ||
    asString(record.response, "").trim() ||
    asString(record.result, "").trim();
  const lines: string[] = direct ? [direct] : [];
  const content = Array.isArray(record.content) ? record.content : [];
  for (const partRaw of content) {
    const part = parseObject(partRaw);
    const partText =
      asString(part.text, "").trim() ||
      asString(part.content, "").trim() ||
      asString(part.output, "").trim();
    if (partText) lines.push(partText);
  }
  return lines;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asString(event.session_id, "").trim() ||
    asString(event.sessionId, "").trim() ||
    asString(event.thread_id, "").trim() ||
    null
  );
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const record = parseObject(value);
  return (
    asString(record.message, "").trim() ||
    asString(record.error, "").trim() ||
    asString(record.code, "").trim() ||
    asString(record.detail, "").trim()
  );
}

function accumulateUsage(
  target: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  usageRaw: unknown,
) {
  const usage = parseObject(usageRaw);
  target.inputTokens += asNumber(usage.input_tokens, asNumber(usage.inputTokens, asNumber(usage.prompt_tokens, 0)));
  target.cachedInputTokens += asNumber(usage.cached_input_tokens, asNumber(usage.cachedInputTokens, 0));
  target.outputTokens += asNumber(usage.output_tokens, asNumber(usage.outputTokens, asNumber(usage.completion_tokens, 0)));
}

export function parseCopilotJsonl(stdout: string) {
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
  const messages: string[] = [];
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

    const foundSessionId = readSessionId(event);
    if (foundSessionId) sessionId = foundSessionId;
    if (event.usage) accumulateUsage(usage, event.usage);

    const type = asString(event.type, "").trim().toLowerCase();
    const role = asString(event.role, "").trim().toLowerCase();
    if (type === "error" || role === "error" || event.is_error === true) {
      const text = errorText(event.error ?? event.message ?? event);
      if (text) errorMessage = text;
      continue;
    }

    if (role === "assistant" || type === "assistant" || type === "message" || type === "result") {
      const texts = [
        ...collectText(event.message),
        ...collectText(event.content),
        ...collectText(event.response),
        ...collectText(event.result),
        ...collectText(event.text),
      ];
      for (const text of texts) {
        if (text) messages.push(text);
      }
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    errorMessage,
  };
}

export function isCopilotAuthRequiredError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = [input.errorMessage, input.stdout, input.stderr]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  return /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|copilot\s+login|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|requires\s+authentication)/i.test(haystack);
}
