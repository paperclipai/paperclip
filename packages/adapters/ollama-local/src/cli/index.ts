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

export function printOllamaLocalStreamEvent(raw: string, _debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // Pass through plain [paperclip] log lines
  if (line.startsWith("[paperclip]")) {
    console.log(pc.gray(line));
    return;
  }

  const parsed = asRecord(safeJsonParse(line));
  if (!parsed) {
    console.log(line);
    return;
  }

  const type = asString(parsed.type);

  if (type === "ollama_text") {
    const text = asString(parsed.text).trim();
    if (text) console.log(pc.green(`assistant: ${text}`));
    return;
  }

  if (type === "ollama_tool_call") {
    const tool = asString(parsed.tool, "tool");
    const args = parsed.args;
    const argsStr = args ? JSON.stringify(args) : "";
    console.log(pc.yellow(`tool_call: ${tool}${argsStr ? ` ${argsStr}` : ""}`));
    return;
  }

  if (type === "ollama_tool_result") {
    const tool = asString(parsed.tool, "tool");
    const result = asString(parsed.result).trim();
    const preview = result.length > 200 ? `${result.slice(0, 200)}...` : result;
    console.log(pc.gray(`tool_result: ${tool}: ${preview}`));
    return;
  }

  if (type === "ollama_error") {
    const message = asString(parsed.message);
    if (message) console.log(pc.red(`error: ${message}`));
    return;
  }

  console.log(line);
}

export const ollamaLocalCLIAdapter = {
  type: "ollama_local",
  formatStdoutEvent: printOllamaLocalStreamEvent,
};
