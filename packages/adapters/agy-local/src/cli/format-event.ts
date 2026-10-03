import pc from "picocolors";
import { normalizeAgyEvents } from "../events.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printAgyStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const events = normalizeAgyEvents(line);
  if (!events) { console.log(line); return; }
  for (const event of events) printEvent(event, line);
}

function printEvent(parsed: Record<string, unknown>, line: string): void {
  const type = asString(parsed.type).trim().toLowerCase();

  if (type === "system") {
    const subtype = asString(parsed.subtype);
    if (subtype === "init") {
      const sessionId = asString(
        parsed.sessionId ?? parsed.session_id ?? parsed.conversationId ?? parsed.conversation_id,
      );
      console.log(pc.blue(`Antigravity CLI init (session: ${sessionId})`));
      return;
    }
    console.log(pc.blue(`system: ${asString(parsed.message ?? parsed.text ?? line)}`));
    return;
  }

  if (type === "error" || type === "stderr") {
    console.log(pc.red(`error: ${asString(parsed.message ?? parsed.error ?? line)}`));
    return;
  }

  if (type === "assistant" || type === "text") {
    console.log(pc.green(`assistant: ${asString(parsed.text ?? parsed.content ?? parsed.message ?? line)}`));
    return;
  }

  if (type === "result") {
    const failed = parsed.isError === true || parsed.is_error === true;
    console.log((failed ? pc.red : pc.green)(`result: ${asString(failed ? parsed.error : parsed.text ?? parsed.response)}`));
    return;
  }

  if (type === "user") {
    console.log(pc.gray(`user: ${asString(parsed.text ?? parsed.content ?? parsed.message ?? line)}`));
    return;
  }

  if (type === "thinking") {
    console.log(pc.gray(`thinking: ${asString(parsed.text ?? line)}`));
    return;
  }

  if (type === "tool_call") {
    console.log(pc.yellow(`tool_call: ${asString(parsed.name ?? parsed.tool ?? "tool")}`));
    return;
  }

  if (type === "tool_result" || type === "tool_response") {
    const isError = parsed.isError === true || parsed.is_error === true;
    console.log((isError ? pc.red : pc.cyan)(`tool_result${isError ? " (error)" : ""}`));
    return;
  }

  console.log(line);
}

export const printAntigravityStreamEvent = printAgyStreamEvent;
