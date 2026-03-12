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

function flattenText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join("\n").trim();
  const record = asRecord(value);
  if (!record) return "";
  if (asString(record.subtype) === "session_start") return "";
  return (
    asString(record.text).trim() ||
    asString(record.content).trim() ||
    asString(record.message).trim() ||
    flattenText(record.part) ||
    flattenText(record.parts) ||
    flattenText(record.contentParts) ||
    flattenText(record.message)
  );
}

export function printQwenStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);
  if (type === "system" || asString(parsed.subtype) === "session_start") {
    const sessionId = asString(parsed.sessionId) || asString(parsed.session_id) || asString(parsed.id);
    const model = asString(parsed.model);
    console.log(pc.blue(`session started${sessionId ? ` (${sessionId})` : ""}${model ? ` model=${model}` : ""}`));
    return;
  }
  if (type === "assistant" || type === "text") {
    const text =
      flattenText(parsed.text) ||
      flattenText(parsed.content) ||
      flattenText(parsed.message) ||
      flattenText(parsed.part) ||
      flattenText(parsed.parts) ||
      flattenText(parsed.contentParts);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }
  if (type === "tool_call") {
    console.log(pc.yellow(`tool_call: ${asString(parsed.name, "tool")}`));
    if (debug && parsed.input !== undefined) console.log(pc.gray(JSON.stringify(parsed.input)));
    return;
  }
  if (type === "tool_result") {
    const text = flattenText(parsed.content) || flattenText(parsed.output);
    console.log((parsed.is_error === true || parsed.isError === true ? pc.red : pc.gray)(`tool_result: ${text}`));
    return;
  }
  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const input = asNumber(usage?.inputTokens, 0) || asNumber(usage?.input_tokens, 0);
    const output = asNumber(usage?.outputTokens, 0) || asNumber(usage?.output_tokens, 0);
    const cost =
      asNumber(usage?.costUsd, 0) ||
      asNumber(usage?.cost_usd, 0) ||
      asNumber(parsed.costUsd, 0) ||
      asNumber(parsed.cost_usd, 0) ||
      asNumber(parsed.cost, 0);
    console.log(
      pc.blue(
        `result: ${flattenText(parsed.summary) || flattenText(parsed.message) || flattenText(parsed.result) || "completed"}`,
      ),
    );
    console.log(pc.blue(`tokens: in=${input} out=${output} cost=$${cost.toFixed(6)}`));
    return;
  }
  if (type === "error") {
    console.log(pc.red(`error: ${flattenText(parsed.error) || flattenText(parsed.message) || line}`));
    return;
  }
  console.log(line);
}
