import pc from "picocolors";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = asRecord(value);
  if (!rec) return "";
  const data = asRecord(rec.data);
  const message =
    asString(rec.message) ||
    asString(data?.message) ||
    asString(rec.name) ||
    "";
  if (message) return message;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function printOpenHandsStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type) || asString(parsed.event_type);

  if (type === "step_start") {
    const sessionId = asString(parsed.sessionId) || asString(parsed.sessionID);
    console.log(pc.blue(`step started${sessionId ? ` (session: ${sessionId})` : ""}`));
    return;
  }

  // Parse message/thinking text
  if (type === "message" || type === "text") {
    const text = asString(parsed.message) || asString(parsed.text) || asString(parsed.content);
    const trimmed = text.trim();
    if (trimmed) console.log(pc.green(`assistant: ${trimmed}`));
    return;
  }

  if (type === "reasoning" || type === "thinking") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text) || asString(parsed.text);
    const trimmed = text.trim();
    if (trimmed) console.log(pc.gray(`thinking: ${trimmed}`));
    return;
  }

  if (type === "tool_use" || type === "tool_call") {
    const part = asRecord(parsed.part);
    const tool = asString(part?.tool, "tool");
    const callID = asString(part?.callID) || asString(part?.id);
    const state = asRecord(part?.state) || asRecord(part?.status);
    const status = asString(state?.status) || asString(part?.status);
    const isError = status === "error" || status === "failed";
    const metadata = asRecord(state?.metadata) || asRecord(part?.metadata);

    console.log(pc.yellow(`tool_call: ${tool}${callID ? ` (${callID})` : ""}`));

    if (status) {
      const metaParts = [`status=${status}`];
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          if (value !== undefined && value !== null) metaParts.push(`${key}=${value}`);
        }
      }
      console.log((isError ? pc.red : pc.gray)(`tool_result ${metaParts.join(" ")}`));
    }

    const output = (asString(state?.output) || asString(state?.error) || asString(part?.output) || asString(part?.error)).trim();
    if (output) console.log((isError ? pc.red : pc.gray)(output));
    return;
  }

  if (type === "step_completion" || type === "step_finish" || type === "completion") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens) || asRecord(parsed.usage);
    const cache = asRecord(tokens?.cache) || asRecord(tokens?.cached);
    const input = asNumber(tokens?.input, 0) || asNumber(tokens?.input_tokens, 0);
    const output = asNumber(tokens?.output, 0) || asNumber(tokens?.output_tokens, 0);
    const cached = asNumber(cache?.read, 0) || asNumber(cache?.cached_tokens, 0) || asNumber(tokens?.cached_input_tokens, 0);
    const cost = asNumber(part?.cost, 0) || asNumber(parsed.cost, 0) || asNumber(parsed.cost_usd, 0);
    const reason = asString(part?.reason, "step") || asString(parsed.status, "step");
    console.log(pc.blue(`step finished: reason=${reason}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    return;
  }

  if (type === "error" || type === "failure") {
    const message = errorText(parsed.error ?? parsed.message ?? parsed.reason);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}
