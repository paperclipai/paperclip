// CLI terminal event formatter for Antigravity stream-json output

import pc from "picocolors";

// Asserts value is a record object
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// Safely coerces value to string with fallback
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// Safely coerces value to finite number with fallback
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Extracts error message string from unknown payload
function errorText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const rec = asRecord(value);
  if (!rec) return "";
  const msg =
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.code === "string" && rec.code) ||
    "";
  if (msg) return msg.trim();
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

// Formats and prints an Antigravity stream-json line to stdout with terminal colors
export function printAntigravityStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const eventName = asString(parsed.event, asString(parsed.type)).trim().toLowerCase();

  // Handle initialization event
  if (eventName === "init") {
    const sessionId = asString(parsed.conversation_id, asString(parsed.sessionId));
    const model = asString(parsed.model);
    const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""]
      .filter(Boolean)
      .join(", ");
    console.log(pc.blue(`Antigravity init${details ? ` (${details})` : ""}`));
    return;
  }

  // Handle step updates
  if (eventName === "step_update") {
    const step = asRecord(parsed.step_update) ?? asRecord(parsed.step) ?? parsed;
    const stepType = asString(step.step_type ?? step.type).trim().toLowerCase();

    if (stepType === "agent_response" || stepType === "planner_response") {
      const text = asString(step.text_delta ?? step.content ?? step.text);
      if (text) console.log(pc.green(text));
      return;
    }

    if (stepType === "thinking") {
      const text = asString(step.thinking ?? step.text ?? step.content);
      if (text) console.log(pc.gray(`thinking: ${text}`));
      return;
    }

    if (stepType === "tool_call") {
      const name = asString(step.tool_name ?? step.name, "tool");
      console.log(pc.yellow(`tool_call: ${name}`));
      return;
    }

    if (stepType === "tool_result") {
      const isError = step.is_error === true || asString(step.status).toLowerCase() === "error";
      console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
      return;
    }

    return;
  }

  // Handle final result event
  if (eventName === "result") {
    const res = asRecord(parsed.result) ?? parsed;
    const usage = asRecord(res.usage) ?? {};
    const input = asNumber(usage.input_tokens, asNumber(usage.inputTokens));
    const output = asNumber(usage.output_tokens, asNumber(usage.outputTokens));
    const cached = asNumber(usage.cache_read_tokens, asNumber(usage.cachedTokens));
    const status = asString(res.status).toLowerCase();
    const isError = status === "error" || status === "failure" || res.is_error === true;

    console.log(pc.blue(`\ntokens: in=${input} out=${output} cached=${cached}`));
    if (isError) {
      const text = errorText(res.error ?? res.message);
      if (text) console.log(pc.red(`error: ${text}`));
    }
    return;
  }

  // Handle error event
  if (eventName === "error") {
    const text = errorText(parsed.error ?? parsed.message ?? parsed.detail);
    if (text) console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}
