import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  let costUsd: number | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  function applyUsage(event: Record<string, unknown>) {
    const usageObj = parseObject(event.usage);
    usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
    usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
    usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
  }

  function applyCost(event: Record<string, unknown>) {
    const nextCostUsd = event.total_cost_usd;
    if (typeof nextCostUsd === "number" && Number.isFinite(nextCostUsd)) {
      costUsd = nextCostUsd;
    }
  }

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      applyUsage(event);
      applyCost(event);
      continue;
    }

    if (type === "turn.failed") {
      applyUsage(event);
      applyCost(event);
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    costUsd,
    errorMessage,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}
