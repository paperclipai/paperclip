import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

function readAssistantText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];

  for (const blockRaw of content) {
    const block = parseObject(blockRaw);
    if (asString(block.type, "") !== "text") continue;
    const text = asString(block.text, "").trim();
    if (text) parts.push(text);
  }

  return parts.join("\n\n").trim();
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePiJsonl(stdout: string) {
  let sessionId: string | null = null;
  let summary = "";
  let errorMessage: string | null = null;
  let provider: string | null = null;
  let model: string | null = null;
  let costUsd: number | null = null;
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
    if (type === "session") {
      sessionId = asString(event.id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "message_end" || type === "turn_end") {
      const message = parseObject(event.message);
      if (asString(message.role, "") !== "assistant") continue;

      const assistantText = readAssistantText(message);
      if (assistantText) summary = assistantText;

      provider = asString(message.provider, provider ?? "") || provider;
      model = asString(message.model, model ?? "") || model;

      const usageObj = parseObject(message.usage);
      usage.inputTokens = asNumber(usageObj.input, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cacheRead, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output, usage.outputTokens);

      const costObj = parseObject(usageObj.cost);
      const totalCost = asNullableNumber(costObj.total);
      if (totalCost !== null) costUsd = totalCost;
    }
  }

  return {
    sessionId,
    summary,
    usage,
    errorMessage,
    provider,
    model,
    costUsd,
  };
}
