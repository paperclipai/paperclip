import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

export function parseAmpStreamJson(stdout: string) {
  let threadId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      threadId = asString(event.session_id, threadId ?? "") || asString(event.thread_id, threadId ?? "") || threadId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      threadId = asString(event.session_id, threadId ?? "") || asString(event.thread_id, threadId ?? "") || threadId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      threadId = asString(event.session_id, threadId ?? "") || asString(event.thread_id, threadId ?? "") || threadId;
    }
  }

  if (!finalResult) {
    return {
      threadId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
    };
  }

  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    threadId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

export function describeAmpFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors
        .map((e: unknown) => {
          if (typeof e === "string") return e.trim();
          if (typeof e === "object" && e !== null && !Array.isArray(e)) {
            const obj = e as Record<string, unknown>;
            return asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
          }
          return "";
        })
        .filter(Boolean)
    : [];

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Amp run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}
