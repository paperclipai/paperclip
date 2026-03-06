import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const GEMINI_AUTH_REQUIRED_RE = /(?:not\s+authenticated|please\s+authenticate|api[_ ]?key\s+(?:required|missing|invalid)|authentication\s+required|unauthorized|invalid\s+credentials|GEMINI_API_KEY|GOOGLE_API_KEY)/i;

export function parseGeminiStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "message") {
      const role = asString(event.role, "");
      if (role === "assistant") {
        const content = asString(event.content, "");
        if (content) assistantTexts.push(content);
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      continue;
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
    };
  }

  const stats = parseObject(finalResult.stats);
  const usage: UsageSummary = {
    inputTokens: asNumber(stats.input_tokens, 0),
    cachedInputTokens: 0,
    outputTokens: asNumber(stats.output_tokens, 0),
  };
  const totalTokens = asNumber(stats.total_tokens, 0);
  if (totalTokens > 0 && usage.inputTokens === 0 && usage.outputTokens === 0) {
    usage.inputTokens = totalTokens;
  }
  const costRaw = finalResult.cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractGeminiErrorMessages(parsed: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const errorMsg = asString(parsed.error, "").trim();
  if (errorMsg) messages.push(errorMsg);

  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }
    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function describeGeminiFailure(parsed: Record<string, unknown>): string | null {
  const status = asString(parsed.status, "");
  const errors = extractGeminiErrorMessages(parsed);

  let detail = errors[0] ?? "";
  const parts = ["Gemini run failed"];
  if (status) parts.push(`status=${status}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function detectGeminiAuthRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const errors = extractGeminiErrorMessages(input.parsed ?? {});
  const messages = [...errors, input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresAuth = messages.some((line) => GEMINI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}

export function isGeminiTurnLimitResult(
  parsed: Record<string, unknown> | null | undefined,
  exitCode?: number | null,
): boolean {
  if (exitCode === 53) return true;
  if (!parsed) return false;

  const status = asString(parsed.status, "").trim().toLowerCase();
  if (status === "turn_limit" || status === "max_turns") return true;

  const error = asString(parsed.error, "").trim();
  return /turn\s*limit|max(?:imum)?\s+turns?/i.test(error);
}
