import pc from "picocolors";
import { normalizeCursorStreamLine } from "../shared/stream.js";

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

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function printUserMessage(messageRaw: unknown): void {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) console.log(pc.gray(`user: ${text}`));
    return;
  }

  const message = asRecord(messageRaw);
  if (!message) return;

  const directText = asString(message.text).trim();
  if (directText) console.log(pc.gray(`user: ${directText}`));

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();
    if (type !== "output_text" && type !== "text") continue;
    const text = asString(part.text).trim();
    if (text) console.log(pc.gray(`user: ${text}`));
  }
}

function printAssistantMessage(messageRaw: unknown): void {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  const message = asRecord(messageRaw);
  if (!message) return;

  const directText = asString(message.text).trim();
  if (directText) console.log(pc.green(`assistant: ${directText}`));

  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();

    if (type === "output_text" || type === "text") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.green(`assistant: ${text}`));
      continue;
    }

    if (type === "thinking") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.gray(`thinking: ${text}`));
      continue;
    }

    if (type === "tool_call") {
      const name = asString(part.name, asString(part.tool, "tool"));
      console.log(pc.yellow(`tool_call: ${name}`));
      const input = part.input ?? part.arguments ?? part.args;
      if (input !== undefined) {
        try {
          console.log(pc.gray(JSON.stringify(input, null, 2)));
        } catch {
          console.log(pc.gray(String(input)));
        }
      }
      continue;
    }

    if (type === "tool_result") {
      const isError = part.is_error === true || asString(part.status).toLowerCase() === "error";
      const contentText =
        asString(part.output) ||
        asString(part.text) ||
        asString(part.result) ||
        stringifyUnknown(part.output ?? part.result ?? part.text ?? part);
      console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
      if (contentText) console.log((isError ? pc.red : pc.gray)(contentText));
    }
  }
}

function printToolCallEventTopLevel(parsed: Record<string, unknown>): void {
  const subtype = asString(parsed.subtype).trim().toLowerCase();
  const callId = asString(parsed.call_id, asString(parsed.callId, asString(parsed.id, "")));
  const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
  if (!toolCall) {
    console.log(pc.yellow(`tool_call${subtype ? `: ${subtype}` : ""}`));
    return;
  }

  const [toolName] = Object.keys(toolCall);
  if (!toolName) {
    console.log(pc.yellow(`tool_call${subtype ? `: ${subtype}` : ""}`));
    return;
  }
  const payload = asRecord(toolCall[toolName]) ?? {};
  const args = payload.args ?? asRecord(payload.function)?.arguments;
  const result =
    payload.result ??
    payload.output ??
    payload.error ??
    asRecord(payload.function)?.result ??
    asRecord(payload.function)?.output;
  const isError =
    parsed.is_error === true ||
    payload.is_error === true ||
    subtype === "failed" ||
    subtype === "error" ||
    subtype === "cancelled" ||
    payload.error !== undefined;

  if (subtype === "started" || subtype === "start") {
    console.log(pc.yellow(`tool_call: ${toolName}${callId ? ` (${callId})` : ""}`));
    if (args !== undefined) {
      console.log(pc.gray(stringifyUnknown(args)));
    }
    return;
  }

  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const header = `tool_result${isError ? " (error)" : ""}${callId ? ` (${callId})` : ""}`;
    console.log((isError ? pc.red : pc.cyan)(header));
    if (result !== undefined) {
      console.log((isError ? pc.red : pc.gray)(stringifyUnknown(result)));
    }
    return;
  }

  console.log(pc.yellow(`tool_call: ${toolName}${subtype ? ` (${subtype})` : ""}`));
}

function printLegacyToolEvent(part: Record<string, unknown>): void {
  const tool = asString(part.tool, "tool");
  const callId = asString(part.callID, asString(part.id, ""));
  const state = asRecord(part.state);
  const status = asString(state?.status);
  const input = state?.input;
  const output = asString(state?.output).replace(/\s+$/, "");
  const metadata = asRecord(state?.metadata);
  const exit = asNumber(metadata?.exit, NaN);
  const isError =
    status === "failed" ||
    status === "error" ||
    status === "cancelled" ||
    (Number.isFinite(exit) && exit !== 0);

  console.log(pc.yellow(`tool_call: ${tool}${callId ? ` (${callId})` : ""}`));
  if (input !== undefined) {
    try {
      console.log(pc.gray(JSON.stringify(input, null, 2)));
    } catch {
      console.log(pc.gray(String(input)));
    }
  }

  if (status || output) {
    const summary = [
      "tool_result",
      status ? `status=${status}` : "",
      Number.isFinite(exit) ? `exit=${exit}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log((isError ? pc.red : pc.cyan)(summary));
    if (output) {
      console.log((isError ? pc.red : pc.gray)(output));
    }
  }
}

export function printCursorStreamEvent(raw: string, _debug: boolean): void {
  const line = normalizeCursorStreamLine(raw).line;
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId =
        asString(parsed.session_id) ||
        asString(parsed.sessionId) ||
        asString(parsed.sessionID);
      const model = asString(parsed.model);
      const details = [sessionId ? `session: ${sessionId}` : "", model ? `model: ${model}` : ""]
        .filter(Boolean)
        .join(", ");
      console.log(pc.blue(`Cursor init${details ? ` (${details})` : ""}`));
      return;
    }
    console.log(pc.blue(`system: ${subtype || "event"}`));
    return;
  }

  if (type === "assistant") {
    printAssistantMessage(parsed.message);
    return;
  }

  if (type === "user") {
    printUserMessage(parsed.message);
    return;
  }

  if (type === "thinking") {
    const text = asString(parsed.text).trim() || asString(asRecord(parsed.delta)?.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "tool_call") {
    printToolCallEventTopLevel(parsed);
    return;
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage);
    const input = asNumber(usage?.input_tokens, asNumber(usage?.inputTokens));
    const output = asNumber(usage?.output_tokens, asNumber(usage?.outputTokens));
    const cached = asNumber(
      usage?.cached_input_tokens,
      asNumber(usage?.cachedInputTokens, asNumber(usage?.cache_read_input_tokens)),
    );
    const cost = asNumber(parsed.total_cost_usd, asNumber(parsed.cost_usd, asNumber(parsed.cost)));
    const subtype = asString(parsed.subtype, "result");
    const isError = parsed.is_error === true || subtype === "error" || subtype === "failed";

    console.log(pc.blue(`result: subtype=${subtype}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    const resultText = asString(parsed.result).trim();
    if (resultText) console.log((isError ? pc.red : pc.green)(`assistant: ${resultText}`));
    const errors = Array.isArray(parsed.errors) ? parsed.errors.map((value) => stringifyUnknown(value)).filter(Boolean) : [];
    if (errors.length > 0) console.log(pc.red(`errors: ${errors.join(" | ")}`));
    return;
  }

  if (type === "error") {
    const message = asString(parsed.message) || stringifyUnknown(parsed.error ?? parsed.detail) || line;
    console.log(pc.red(`error: ${message}`));
    return;
  }

  // Compatibility with older stream-json event shapes.
  if (type === "step_start") {
    const sessionId = asString(parsed.sessionID);
    console.log(pc.blue(`step started${sessionId ? ` (session: ${sessionId})` : ""}`));
    return;
  }

  if (type === "text") {
    const part = asRecord(parsed.part);
    const text = asString(part?.text);
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "tool_use") {
    const part = asRecord(parsed.part);
    if (part) {
      printLegacyToolEvent(part);
    } else {
      console.log(pc.yellow("tool_use"));
    }
    return;
  }

  if (type === "step_finish") {
    const part = asRecord(parsed.part);
    const tokens = asRecord(part?.tokens);
    const cache = asRecord(tokens?.cache);
    const reason = asString(part?.reason, "step_finish");
    const input = asNumber(tokens?.input);
    const output = asNumber(tokens?.output);
    const cached = asNumber(cache?.read);
    const cost = asNumber(part?.cost);
    console.log(pc.blue(`step finished: reason=${reason}`));
    console.log(pc.blue(`tokens: in=${input} out=${output} cached=${cached} cost=$${cost.toFixed(6)}`));
    return;
  }

  console.log(line);
}
