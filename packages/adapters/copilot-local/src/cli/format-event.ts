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

function asBoolean(value: unknown): boolean {
  return value === true;
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  const rec = asRecord(result);
  if (rec) {
    const content = asString(rec.content).trim();
    if (content) return content;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

export function printCopilotStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);
  const data = asRecord(parsed.data) ?? {};

  if (type === "assistant.message_delta") return;

  if (type === "session.mcp_servers_loaded" || type === "session.skills_loaded" || type === "session.mcp_server_status_changed" || type === "session.background_tasks_changed") {
    if (!debug) return;
    console.log(pc.gray(`session: ${type}`));
    return;
  }

  if (type === "session.tools_updated") {
    const model = asString(data.model);
    if (model) console.log(pc.blue(`model: ${model}`));
    return;
  }

  if (type === "user.message") {
    const content = asString(data.content).trim();
    if (content) console.log(pc.cyan(`user: ${content}`));
    return;
  }

  if (type === "assistant.turn_start") {
    if (debug) console.log(pc.gray("turn started"));
    return;
  }

  if (type === "assistant.reasoning") {
    const text = asString(data.text).trim();
    if (text) console.log(pc.gray(`thinking: ${text}`));
    return;
  }

  if (type === "assistant.message") {
    const content = asString(data.content).trim();
    if (content) console.log(pc.green(`assistant: ${content}`));
    const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
    for (const tr of toolRequests) {
      const trRec = asRecord(tr);
      if (!trRec) continue;
      const name = asString(trRec.name, "tool");
      const callId = asString(trRec.toolCallId) || asString(trRec.callId);
      console.log(pc.yellow(`tool_call: ${name}${callId ? ` (${callId})` : ""}`));
    }
    return;
  }

  if (type === "tool.execution_start") {
    if (!debug) return;
    const toolName = asString(data.toolName, "tool");
    console.log(pc.gray(`tool_start: ${toolName}`));
    return;
  }

  if (type === "tool.execution_complete") {
    const errorRec = asRecord(data.error);
    const success = data.success;
    const isError =
      success === false ||
      (errorRec !== null && Object.keys(errorRec).length > 0) ||
      (typeof data.error === "string" && (data.error as string).trim().length > 0);
    const callId = asString(data.toolCallId) || asString(data.callId);
    const text = (isError ? stringifyToolResult(data.error) : stringifyToolResult(data.result)) || (isError ? "tool failed" : "tool completed");
    const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 240);
    console.log((isError ? pc.red : pc.gray)(`tool_result${callId ? ` (${callId})` : ""}: ${trimmed}`));
    return;
  }

  if (type === "result") {
    const usage = asRecord(parsed.usage) ?? {};
    const premium = asNumber(usage.premiumRequests, 0);
    const sessionId = asString(parsed.sessionId);
    console.log(pc.blue(`result: premiumRequests=${premium}${sessionId ? ` session=${sessionId}` : ""}`));
    return;
  }

  if (type === "error") {
    const message = asString((asRecord(parsed.error) ?? {}).message) || asString(parsed.message) || line;
    console.log(pc.red(`error: ${message}`));
    return;
  }

  if (asBoolean(parsed.ephemeral) && !debug) return;
  console.log(line);
}
