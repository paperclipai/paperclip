import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseQodoOutput(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let errorMessage: string | null = null;
  let resultJson: Record<string, unknown> | null = null;
  const textParts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) {
      if (line.length > 0) textParts.push(rawLine);
      continue;
    }

    const type = asString(event.type, "");

    if (type === "system" || type === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      const text = asString(event.text, "");
      if (text) textParts.push(text);
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      errorMessage = asString(event.message, "") || asString(event.error, "") || null;
      continue;
    }

    if (type === "result") {
      resultJson = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  const summary = textParts.join("\n").trim();

  if (!resultJson) {
    return { sessionId, model, costUsd: null as number | null, usage: null as UsageSummary | null, summary, resultJson: null as Record<string, unknown> | null, errorMessage };
  }

  const usageObj = parseObject(resultJson.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = resultJson.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary: asString(resultJson.result, summary).trim(),
    resultJson,
    errorMessage: errorMessage ?? (asString(resultJson.error, "") || null),
  };
}

export function describeQodoFailure(parsed: Record<string, unknown>): string | null {
  const detail = asString(parsed.result, "").trim() || asString(parsed.error, "").trim();
  return detail ? `Qodo run failed: ${detail}` : null;
}

export function isQodoUnknownSessionError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /(?:unknown session|session .* not found|no (?:conversation|session) found|invalid session)/i.test(combined);
}
