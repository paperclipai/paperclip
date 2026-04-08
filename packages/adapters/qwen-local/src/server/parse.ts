import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

/**
 * Parse Qwen Code stream-json output (NDJSON).
 *
 * Qwen Code emits line-delimited JSON with event types:
 * - system (subtype: init) — session start with session_id, model
 * - assistant — assistant messages with content blocks (text, tool_use, thinking)
 * - user — user messages (including tool_result)
 * - result — final result with usage, cost, response
 */
export function parseQwenStreamJson(stdout: string): {
  sessionId: string | null;
  model: string | null;
  costUsd: number | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
  summary: string;
  resultJson: Record<string, unknown> | null;
} {
  const lines = stdout.split(/\r?\n/);
  let sessionId: string | null = null;
  let model: string | null = null;
  let costUsd: number | null = null;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let summary = "";
  let resultJson: Record<string, unknown> | null = null;
  const parts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const obj = asRecord(parsed);
    if (!obj) continue;

    const type = asString(obj.type);

    if (type === "system" && obj.subtype === "init") {
      sessionId = asString(obj.session_id) || asString(obj.sessionId) || sessionId;
      model = asString(obj.model) || model;
      continue;
    }

    if (type === "result") {
      resultJson = obj as Record<string, unknown>;
      const usage = asRecord(obj.usage);
      if (usage) {
        inputTokens = asNumber(usage.input_tokens) || inputTokens;
        cachedInputTokens =
          asNumber(usage.cache_read_input_tokens) || asNumber(usage.cached_tokens) || cachedInputTokens;
        outputTokens = asNumber(usage.output_tokens) || outputTokens;
      }
      costUsd = asNumber(obj.total_cost_usd) || asNumber(obj.cost_usd) || costUsd;
      summary = asString(obj.response) || asString(obj.result) || asString(obj.content) || summary;
      model = asString(obj.model) || model;
      sessionId = asString(obj.session_id) || asString(obj.sessionId) || sessionId;
      continue;
    }

    // Accumulate assistant text for summary fallback
    if (type === "assistant") {
      const message = asRecord(obj.message);
      if (message && Array.isArray(message.content)) {
        for (const block of message.content) {
          const b = asRecord(block);
          if (!b) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            parts.push(b.text);
          }
        }
      }
    }
  }

  if (!summary && parts.length > 0) {
    summary = parts.join("\n\n");
  }

  return {
    sessionId,
    model,
    costUsd,
    usage: { inputTokens, cachedInputTokens, outputTokens },
    summary,
    resultJson,
  };
}

/**
 * Describe why a Qwen Code run failed based on parsed output.
 */
export function describeQwenFailure(parsed: Record<string, unknown>): string | null {
  const error = asString(parsed.error) || asString(parsed.error_message) || asString(parsed.message);
  if (error) return error;

  const resultText = asString(parsed.result) || asString(parsed.response) || asString(parsed.content);
  const subtype = asString(parsed.subtype).toLowerCase();
  if (parsed.is_error === true && resultText) return resultText;
  if (subtype === "error" || subtype === "failed") return resultText || "Qwen Code reported an error";
  if (/^\[(api error|auth error|error):/i.test(resultText)) return resultText;

  const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  if (errors.length > 0) {
    return errors.map((e: unknown) => errorText(e)).filter(Boolean).join("; ");
  }

  return null;
}

/**
 * Detect whether the result indicates max turns were reached.
 * When max turns is hit, Qwen Code returns a result with an indicator
 * that the session should be cleared for the next run.
 */
export function isQwenMaxTurnsResult(parsed: Record<string, unknown>): boolean {
  const subtype = asString(parsed.subtype).toLowerCase();
  const stopReason = asString(parsed.stop_reason).toLowerCase();
  const message = (asString(parsed.error) || asString(parsed.error_message) || "").toLowerCase();

  return (
    subtype === "max_turns" ||
    stopReason === "max_turns" ||
    message.includes("max turns") ||
    message.includes("maximum turns")
  );
}

/**
 * Detect if a Qwen Code session is stale/unknown (for resume retry logic).
 */
export function isQwenUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const msg = (asString(parsed.error) || asString(parsed.error_message) || "").toLowerCase();
  return (
    msg.includes("unknown session") ||
    msg.includes("session not found") ||
    msg.includes("no such session") ||
    msg.includes("session expired") ||
    msg.includes("invalid session")
  );
}

/**
 * Detect whether Qwen output indicates a login is required.
 */
export function detectQwenLoginRequired(ctx: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const combined = `${ctx.stdout}\n${ctx.stderr}`.toLowerCase();

  if (
    combined.includes("authentication required") ||
    combined.includes("not authenticated") ||
    combined.includes("please log in") ||
    combined.includes("login required") ||
    combined.includes("unauthorized")
  ) {
    return { requiresLogin: true, loginUrl: null };
  }

  return { requiresLogin: false, loginUrl: null };
}
