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

function extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text!)
    .join("");
}

export function printPiStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "agent_start") {
    console.log(pc.blue("Pi agent started"));
    return;
  }

  if (type === "agent_end") {
    console.log(pc.blue("Pi agent finished"));
    return;
  }

  if (type === "turn_start") {
    console.log(pc.blue("Turn started"));
    return;
  }

  if (type === "turn_end") {
    const message = asRecord(parsed.message);
    if (message) {
      const content = message.content as string | Array<{ type: string; text?: string }>;
      const text = extractTextContent(content);
      if (text) {
        console.log(pc.green(`assistant: ${text}`));
      }
    }
    return;
  }

  if (type === "message_update") {
    const assistantEvent = asRecord(parsed.assistantMessageEvent);
    if (assistantEvent) {
      const msgType = asString(assistantEvent.type);
      if (msgType === "text_delta") {
        const delta = asString(assistantEvent.delta);
        if (delta) {
          console.log(pc.green(delta));
        }
      }
    }
    return;
  }

  if (type === "tool_execution_start") {
    const toolName = asString(parsed.toolName);
    const args = parsed.args;
    console.log(pc.yellow(`tool_start: ${toolName}`));
    if (args !== undefined) {
      try {
        console.log(pc.gray(JSON.stringify(args, null, 2)));
      } catch {
        console.log(pc.gray(String(args)));
      }
    }
    return;
  }

  if (type === "tool_execution_end") {
    const result = parsed.result;
    const isError = parsed.isError === true;
    const output = typeof result === "string" ? result : JSON.stringify(result);
    if (output) {
      console.log((isError ? pc.red : pc.gray)(output));
    }
    return;
  }

  console.log(line);
}
