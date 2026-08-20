import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

const CODEBUDDY_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+logged\s+in|please\s+(?:use\s+)?\/login|please\s+log\s+in|login\s+required|requires\s+login|unauthorized|invalid\s+api\s+key)/i;

export function detectCodeBuddyLoginRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; message: string | null } {
  const combined = `${input.stdout}\n${input.stderr}`;
  const match = combined.match(
    /Authentication required\.[^\n]*|Please use \/login[^\n]*|not logged in[^\n]*/i,
  );
  if (match || CODEBUDDY_AUTH_REQUIRED_RE.test(combined)) {
    return {
      requiresLogin: true,
      message:
        (match?.[0] ?? "Authentication required. Please use /login to sign in to CodeBuddy.").trim(),
    };
  }
  return { requiresLogin: false, message: null };
}

export function parseCodeBuddyStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const event = parseJson(rawLine.trim());
    if (!event) continue;
    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }
    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      for (const entry of Array.isArray(message.content) ? message.content : []) {
        const block = parseObject(entry);
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }
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
      usageBasis: null as "per_run" | null,
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
  return {
    sessionId,
    model,
    costUsd: typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null,
    usage,
    usageBasis: "per_run" as const,
    summary: asString(finalResult.result, assistantTexts.join("\n\n")).trim(),
    resultJson: finalResult,
  };
}

export function describeCodeBuddyFailure(parsed: Record<string, unknown> | null): string | null {
  if (!parsed) return null;
  const subtype = asString(parsed.subtype, "");
  const result = asString(parsed.result, "").trim();
  const errors = Array.isArray(parsed.errors)
    ? parsed.errors.map((value) => asString(parseObject(value).message, "") || asString(value, "")).filter(Boolean)
    : [];
  const detail = result || errors[0] || "";
  return [subtype ? `subtype=${subtype}` : "", detail].filter(Boolean).join(": ") || null;
}

export function isCodeBuddyUnknownSessionError(parsed: Record<string, unknown> | null): boolean {
  if (!parsed) return false;
  const text = [
    asString(parsed.result, ""),
    ...(Array.isArray(parsed.errors)
      ? parsed.errors.map((value) => asString(parseObject(value).message, "") || asString(value, ""))
      : []),
  ].join("\n");
  return /no conversation found with session id|unknown session|session .* not found|not a valid UUID|cannot resume/i.test(text);
}
