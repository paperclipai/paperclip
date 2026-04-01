import type { UsageSummary } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CLAUDE_AUTH_REQUIRED_RE = /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+`?claude\s+login`?|login\s+required|requires\s+login|unauthorized|authentication\s+required)/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

export function parseClaudeStreamJson(stdout: string) {
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
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

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
    sessionId,
    model,
    costUsd,
    usage,
    summary,
    resultJson: finalResult,
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

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

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const resultText = asString(input.parsed?.result, "").trim();
  const messages = [resultText, ...extractClaudeErrorMessages(input.parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requiresLogin = messages.some((line) => CLAUDE_AUTH_REQUIRED_RE.test(line));
  return {
    requiresLogin,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const stopReason = asString(parsed.stop_reason, "").trim().toLowerCase();
  if (stopReason === "max_turns") return true;

  const resultText = asString(parsed.result, "").trim();
  return /max(?:imum)?\s+turns?/i.test(resultText);
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found/i.test(msg),
  );
}

export function isClaudeContextWindowError(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /reached\s+its\s+context\s+window\s+limit|context.window.limit|context.limit.reached|context.length.exceeded|token.limit|maximum.context/i.test(msg),
  );
}

/**
 * Stuck session variants detected in corrupted session JSONL files.
 * See issue #2358 for details.
 */
export type StuckSessionVariant =
  | "stop_sequence_synthetic"
  | "incomplete_tool_use"
  | "unknown";

export interface StuckSessionInfo {
  isStuck: boolean;
  variant: StuckSessionVariant;
  lastEntry: Record<string, unknown> | null;
}

/**
 * Detect if a session JSONL file is stuck in a corrupted state.
 *
 * Two variants are known to cause immediate exit on resume:
 *
 * Variant A — Synthetic stop_sequence with 0 tokens:
 * The last JSONL entry is an assistant message with stop_reason="stop_sequence"
 * and output_tokens=0. This synthetic marker renders the session unresumable.
 *
 * Variant B — Incomplete tool_use with no tool_result:
 * The last JSONL entry is an assistant message with stop_reason=null,
 * stop_sequence=null, a tool_use content block, and near-zero output tokens.
 * The corresponding tool_result is missing.
 *
 * @param lastLineContent - The last line of the session JSONL file (raw JSON string)
 * @returns StuckSessionInfo indicating if the session is stuck and which variant
 */
export function detectStuckSession(lastLineContent: string): StuckSessionInfo {
  const parsed = parseJson(lastLineContent);
  if (!parsed) {
    return { isStuck: false, variant: "unknown", lastEntry: null };
  }

  const event = parseObject(parsed);
  const type = asString(event.type, "");
  if (type !== "assistant") {
    return { isStuck: false, variant: "unknown", lastEntry: null };
  }

  const message = parseObject(event.message);
  const role = asString(message.role, "");
  if (role !== "assistant") {
    return { isStuck: false, variant: "unknown", lastEntry: null };
  }

  const stopReason = asString(message.stop_reason, "");
  const stopSeq = message.stop_sequence;
  const content = Array.isArray(message.content) ? message.content : [];
  const contentTypes = content
    .map((block) => typeof block === "object" && block !== null ? asString(block.type, "") : "")
    .filter(Boolean);

  const usageObj = parseObject(message.usage);
  const outputTokens = asNumber(usageObj.output_tokens, 0);

  // Variant A: synthetic stop_sequence with 0 tokens
  if (stopReason === "stop_sequence" && outputTokens === 0) {
    return {
      isStuck: true,
      variant: "stop_sequence_synthetic",
      lastEntry: event,
    };
  }

  // Variant B: null stop_reason + null stop_sequence + pending tool_use + near-zero tokens
  const hasToolUse = contentTypes.includes("tool_use");
  const nearZeroTokens = outputTokens <= 5;
  const isNullStop = stopReason === "" || stopReason === "null";
  const isNullSeq = stopSeq === null || stopSeq === "" || stopSeq === "null";

  if (isNullStop && isNullSeq && hasToolUse && nearZeroTokens) {
    return {
      isStuck: true,
      variant: "incomplete_tool_use",
      lastEntry: event,
    };
  }

  return { isStuck: false, variant: "unknown", lastEntry: event };
}
