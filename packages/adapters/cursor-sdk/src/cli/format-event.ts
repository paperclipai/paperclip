import pc from "picocolors";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
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

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function printAssistant(messageRaw: unknown): void {
  if (typeof messageRaw === "string") {
    const text = messageRaw.trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }
  const message = asRecord(messageRaw);
  if (!message) return;
  const direct = asString(message.text).trim();
  if (direct) console.log(pc.green(`assistant: ${direct}`));
  const content = Array.isArray(message.content) ? message.content : [];
  for (const partRaw of content) {
    const part = asRecord(partRaw);
    if (!part) continue;
    const type = asString(part.type).trim();
    if (type === "text" || type === "output_text") {
      const text = asString(part.text).trim();
      if (text) console.log(pc.green(`assistant: ${text}`));
    } else if (type === "tool_call") {
      const name = asString(part.name, "tool");
      console.log(pc.yellow(`tool_call: ${name}`));
      const input = part.input ?? part.args ?? part.arguments;
      if (input !== undefined) console.log(pc.gray(stringifyUnknown(input)));
    }
  }
}

function printToolCallEvent(parsed: Record<string, unknown>): void {
  const subtype = asString(parsed.subtype).trim().toLowerCase();
  const toolCall = asRecord(parsed.tool_call ?? parsed.toolCall);
  if (!toolCall) {
    console.log(pc.yellow(`tool_call${subtype ? `: ${subtype}` : ""}`));
    return;
  }
  const [toolName] = Object.keys(toolCall);
  const payload = toolName ? asRecord(toolCall[toolName]) ?? {} : {};

  if (subtype === "started" || subtype === "start") {
    console.log(pc.yellow(`tool_call started: ${toolName ?? "tool"}`));
    if (payload.args !== undefined) console.log(pc.gray(stringifyUnknown(payload.args)));
    return;
  }
  if (subtype === "completed" || subtype === "complete" || subtype === "finished") {
    const isError =
      parsed.is_error === true ||
      payload.is_error === true ||
      asString(payload.status).toLowerCase() === "error" ||
      asString(payload.status).toLowerCase() === "failed";
    const result = payload.result ?? payload.output ?? payload.error;
    console.log((isError ? pc.red : pc.cyan)(`tool_call completed: ${toolName ?? "tool"}${isError ? " (error)" : ""}`));
    if (result !== undefined) console.log((isError ? pc.red : pc.gray)(stringifyUnknown(result)));
    return;
  }
  console.log(pc.yellow(`tool_call${subtype ? ` (${subtype})` : ""}: ${toolName ?? "tool"}`));
}

export function printCursorSdkStreamEvent(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parsed = asRecord(safeJsonParse(trimmed));
  if (!parsed) {
    console.log(trimmed);
    return;
  }
  const type = asString(parsed.type);

  if (type === "system") {
    if (asString(parsed.subtype) === "init") {
      const model = asString(parsed.model, "cursor");
      const sessionId = asString(parsed.sessionId);
      const runtime = asString(parsed.runtime);
      console.log(pc.cyan(`init: model=${model}${sessionId ? ` session=${sessionId}` : ""}${runtime ? ` runtime=${runtime}` : ""}`));
    } else {
      console.log(pc.cyan(`system${parsed.subtype ? `: ${parsed.subtype}` : ""}`));
    }
    return;
  }
  if (type === "assistant") return printAssistant(parsed.message);
  if (type === "user") {
    const text = asString(asRecord(parsed.message)?.text).trim() || asString(parsed.text).trim();
    if (text) console.log(pc.gray(`user: ${text}`));
    return;
  }
  if (type === "thinking") {
    const text = asString(parsed.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }
  if (type === "tool_call") return printToolCallEvent(parsed);
  if (type === "status") {
    console.log(pc.cyan(`status: ${asString(parsed.status, "running")}`));
    return;
  }
  if (type === "task") {
    const subtype = asString(parsed.subtype);
    const text = asString(parsed.text).trim();
    console.log(pc.cyan(`task${subtype ? ` (${subtype})` : ""}${text ? `: ${text}` : ""}`));
    return;
  }
  if (type === "request") {
    const text = asString(parsed.text).trim();
    console.log(pc.yellow(`request${text ? `: ${text}` : ": awaiting input"}`));
    return;
  }
  if (type === "result") {
    const subtype = asString(parsed.subtype, "result");
    const isError = parsed.is_error === true || subtype === "error" || subtype === "cancelled";
    const text = asString(parsed.result).trim();
    console.log((isError ? pc.red : pc.green)(`result (${subtype})${text ? `: ${text}` : ""}`));
    return;
  }
  if (type === "error") {
    console.log(pc.red(`error: ${asString(parsed.message) || trimmed}`));
    return;
  }
  console.log(trimmed);
}
