import pc from "picocolors";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function printCodeBuddyStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;
  let event: Record<string, unknown>;
  try {
    event = record(JSON.parse(line));
  } catch {
    console.log(line);
    return;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "system" && event.subtype === "init") {
    console.log(pc.blue(`CodeBuddy initialized (${String(event.model ?? "unknown")})`));
    return;
  }
  if (type === "assistant") {
    const message = record(event.message);
    for (const rawBlock of Array.isArray(message.content) ? message.content : []) {
      const block = record(rawBlock);
      if (block.type === "text" && typeof block.text === "string") {
        console.log(pc.green(`assistant: ${block.text}`));
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        console.log(pc.gray(`thinking: ${block.thinking}`));
      } else if (block.type === "tool_use") {
        console.log(pc.yellow(`tool_call: ${String(block.name ?? "unknown")}`));
      }
    }
    return;
  }
  if (type === "result") {
    if (typeof event.result === "string" && event.result) console.log(event.result);
    const usage = record(event.usage);
    console.log(pc.blue(
      `tokens: in=${Number(usage.input_tokens ?? 0)} out=${Number(usage.output_tokens ?? 0)} cached=${Number(usage.cache_read_input_tokens ?? 0)}`,
    ));
    return;
  }
  if (debug) console.log(pc.gray(line));
}
