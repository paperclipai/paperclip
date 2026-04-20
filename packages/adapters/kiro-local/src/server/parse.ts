import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

/**
 * Parse Kiro CLI JSON output lines.
 *
 * Kiro CLI in `--format json` + `--no-interactive` mode emits JSON objects
 * to stdout. We parse each line and accumulate assistant text, usage, session,
 * and error information.
 */
export function parseKiroJsonOutput(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];
  let errorMessage: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) {
      // Kiro may emit plain-text assistant responses in non-JSON mode
      if (line.length > 0 && !line.startsWith("{")) {
        assistantTexts.push(line);
      }
      continue;
    }

    const type = asString(event.type, "");

    // Session initialization
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    // Assistant message
    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
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
      // Also handle direct text field
      const directText = asString(event.text, "");
      if (directText) assistantTexts.push(directText);
      continue;
    }

    // Error events
    if (type === "error") {
      errorMessage = asString(event.message, "") || asString(event.error, "") || null;
      continue;
    }

    // Result / completion
    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      errorMessage,
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
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
    errorMessage: errorMessage ?? (asString(finalResult.error, "") || null),
  };
}

export function describeKiroFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errorText = asString(parsed.error, "").trim();

  let detail = resultText || errorText;
  if (!detail) {
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    for (const entry of errors) {
      if (typeof entry === "string" && entry.trim()) {
        detail = entry.trim();
        break;
      }
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        const obj = entry as Record<string, unknown>;
        detail = asString(obj.message, "") || asString(obj.error, "");
        if (detail) break;
      }
    }
  }

  const parts = ["Kiro run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isKiroUnknownSessionError(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /(?:unknown session|session .* not found|no (?:conversation|session) found|invalid session)/i.test(
    combined,
  );
}
